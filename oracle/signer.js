'use strict';

/**
 * The ERC-8004 publisher's signer, on a host other than the publisher's (docs/adr/0008, decision 4;
 * runbook section 5). It holds the publisher key, in an encrypted keystore, and signs three things
 * only:
 *
 *   - giveFeedback on the ERC-8004 Reputation Registry, tagged sigvara/score, a value of 0 to 100
 *     with no decimals, no endpoint, and a data: feedback URI holding JSON;
 *   - revokeFeedback on the same registry;
 *   - the EIP-712 AgentWalletSet message that makes its own address the agentWallet of Sigvara's
 *     registration, for the registration's owner, due within five minutes.
 *
 * Each transaction is type 2, with no value and no access list or authorization, under a gas and
 * fee cap, and at the publisher's next nonce as the chain has it, so nothing can be signed ahead
 * and held. It signs no more than SIGNER_MAX_PER_HOUR an hour, counted across restarts. So a
 * compromised publisher host can make it post wrong Sigvara scores, at the rate of the cap and for
 * as long as it is compromised, but cannot make it move funds, delegate the account (EIP-7702),
 * call any other contract, or sign anything to use later. Requests must carry the HMAC in
 * signer-auth.js and come from an address in SIGNER_ALLOW_FROM.
 *
 * Testnet only, by David's decision of 3 November 2026: the key is in a file, encrypted, and not in
 * a KMS or HSM. Mainnet needs one.
 *
 *   node signer.js new-keystore <path>   writes a new encrypted keystore, prints only its address
 *   node signer.js                       serves
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ethers } = require('ethers');
const { HEADER, MAX_SKEW_SECONDS, authProblem, readSecret } = require('./signer-auth');

const FEEDBACK = new ethers.Interface([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
]);
const WALLET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
};
const DOMAIN_KEYS = ['chainId', 'name', 'verifyingContract', 'version'];
const MAX_BODY = 64 * 1024;
const MAX_FEEDBACK_URI = 4096;
const DATA_URI = 'data:application/json;base64,';
// What setAgentWallet allows (IdentityRegistryUpgradeable.MAX_DEADLINE_DELAY).
const MAX_DEADLINE_DELAY = 300;

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const big = (x) => (x === undefined || x === null ? null : BigInt(x));

/**
 * What the signer will sign. Each check returns why not, or null. The signer then signs a
 * transaction or message rebuilt from the checked values alone, so nothing unchecked rides along.
 * `chain` is what the chain says now: { pendingNonce, time }.
 */
function createPolicy({ address, chainId, reputationRegistry, identityRegistry, agentId, agentOwner, maxGas, maxFeeWei }) {
  function transaction(t, chain) {
    if (!same(t.from, address)) return `from is not ${address}`;
    if (t.type !== undefined && big(t.type) !== 2n) return 'only type-2 transactions';
    if (!same(t.to, reputationRegistry)) return 'only calls to the ERC-8004 Reputation Registry';
    if ((big(t.value) ?? 0n) !== 0n) return 'no value';
    if (big(t.chainId) !== BigInt(chainId)) return `only chain ${chainId}`;
    if ((t.accessList && t.accessList.length) || (t.authorizationList && t.authorizationList.length)) return 'no access list or authorization';
    if (big(t.gas ?? t.gasLimit) === null || big(t.gas ?? t.gasLimit) > maxGas) return `gas above ${maxGas}`;
    const fee = big(t.maxFeePerGas);
    const tip = big(t.maxPriorityFeePerGas);
    if (fee === null || tip === null) return 'maxFeePerGas and maxPriorityFeePerGas are required';
    if (fee > maxFeeWei) return 'fee above the cap';
    if (tip > fee) return 'priority fee above the fee';
    // The next nonce and no other: a signature for a later one could be held and used after the
    // publisher host that asked for it has been cleaned up.
    if (big(t.nonce) !== BigInt(chain.pendingNonce)) return `only the next nonce, ${chain.pendingNonce}`;
    let call;
    try { call = FEEDBACK.parseTransaction({ data: t.data }); } catch { call = null; }
    if (!call) return 'only giveFeedback or revokeFeedback';
    // Exactly the call, with nothing after it.
    if (FEEDBACK.encodeFunctionData(call.name, call.args).toLowerCase() !== String(t.data).toLowerCase()) return 'calldata that is not exactly one call';
    if (call.name === 'giveFeedback') {
      const [, value, decimals, tag1, tag2, endpoint, uri] = call.args;
      if (tag1 !== 'sigvara' || tag2 !== 'score') return 'only feedback tagged sigvara/score';
      if (Number(decimals) !== 0 || value < 0n || value > 100n) return 'only a value of 0 to 100 with no decimals';
      if (endpoint !== '') return 'no endpoint';
      if (!uri.startsWith(DATA_URI) || uri.length > MAX_FEEDBACK_URI) return 'only a data: feedback URI';
      try { JSON.parse(Buffer.from(uri.slice(DATA_URI.length), 'base64').toString('utf8')); } catch { return 'a feedback URI that does not hold JSON'; }
    }
    return null;
  }

  function typedData(signer, typed, chain) {
    if (!same(signer, address)) return `not ${address}`;
    const d = typed?.domain ?? {};
    if (typed?.primaryType !== 'AgentWalletSet') return 'only AgentWalletSet';
    if (Object.keys(d).sort().join(',') !== DOMAIN_KEYS.join(',')) return 'a domain of name, version, chainId and verifyingContract only';
    if (d.name !== 'ERC8004IdentityRegistry' || d.version !== '1' || big(d.chainId) !== BigInt(chainId) || !same(d.verifyingContract, identityRegistry)) {
      return 'only the ERC-8004 Identity Registry on this chain';
    }
    const fields = (typed.types?.AgentWalletSet ?? []).map((f) => `${f.type} ${f.name}`).join(',');
    if (fields !== WALLET_TYPES.AgentWalletSet.map((f) => `${f.type} ${f.name}`).join(',')) return 'unexpected AgentWalletSet fields';
    const m = typed.message ?? {};
    if (big(m.agentId) !== BigInt(agentId)) return `only agent ${agentId}`;
    if (!same(m.newWallet, address)) return 'only this signer as the new wallet';
    if (!same(m.owner, agentOwner)) return `only for the registration's owner, ${agentOwner}`;
    const deadline = big(m.deadline);
    if (deadline === null || deadline < BigInt(chain.time) || deadline > BigInt(chain.time) + BigInt(MAX_DEADLINE_DELAY)) {
      return `only a deadline within ${MAX_DEADLINE_DELAY} s of the chain's clock`;
    }
    return null;
  }

  // The message as signed: rebuilt from the values just checked, never the request's own objects.
  function walletMessage(typed) {
    return {
      domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: Number(chainId), verifyingContract: ethers.getAddress(identityRegistry) },
      message: {
        agentId: BigInt(agentId), newWallet: ethers.getAddress(address), owner: ethers.getAddress(agentOwner), deadline: big(typed.message.deadline),
      },
    };
  }

  return { transaction, typedData, walletMessage };
}

/**
 * The record of when it signed, kept in a file so that a restart does not reset the hourly cap.
 * `file` null keeps it in memory, for tests.
 */
function signedRecord(file) {
  let times = [];
  if (file) {
    try { times = JSON.parse(fs.readFileSync(file, 'utf8')).signed ?? []; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return {
    since: (t) => { times = times.filter((s) => s > t - 3600); return times.length; },
    add: (t) => {
      times.push(t);
      if (!file) return;
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ signed: times })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    },
  };
}

/**
 * The HTTP handler. `wallet` is an ethers Wallet, `secret` the shared HMAC secret, `allowFrom` the
 * set of addresses requests may come from, `chain()` what the chain says now, `record` the
 * signedRecord. It refuses to sign for MAX_SKEW_SECONDS after it starts: the record of requests
 * already used does not survive a restart, and a request older than that is refused anyway.
 */
function createSigner({ wallet, policy, secret, allowFrom, maxPerHour, chainId, chain, record, log = console.log, now = () => Math.floor(Date.now() / 1000), warmup = MAX_SKEW_SECONDS }) {
  const seen = new Map();
  const startedAt = now();
  let busy = Promise.resolve();
  const answer = (res, id, result, error) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error: { code: -32000, message: error } } : { jsonrpc: '2.0', id, result }));
  };

  async function sign(method, params, t) {
    if (t < startedAt + warmup) return { error: `starting; signing from ${warmup} s after start` };
    if (record.since(t) >= maxPerHour) return { error: `no more than ${maxPerHour} signatures an hour` };
    const state = await chain();
    if (method === 'eth_signTransaction') {
      const tx = params[0] ?? {};
      const why = policy.transaction(tx, state);
      if (why) { log(`[signer] refused a transaction: ${why}`); return { error: `refused: ${why}` }; }
      const raw = await wallet.signTransaction({
        type: 2, to: ethers.getAddress(tx.to), data: tx.data, nonce: Number(big(tx.nonce)), gasLimit: big(tx.gas ?? tx.gasLimit),
        chainId: BigInt(chainId), value: 0n, maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
      });
      record.add(t);
      const call = FEEDBACK.parseTransaction({ data: tx.data });
      log(`[signer] signed ${call.name} agent ${call.args[0]}${call.name === 'giveFeedback' ? ` value ${call.args[1]}` : ` #${call.args[1]}`} nonce ${big(tx.nonce)}`);
      return { result: raw };
    }
    const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    const why = policy.typedData(params[0], typed, state);
    if (why) { log(`[signer] refused typed data: ${why}`); return { error: `refused: ${why}` }; }
    const { domain, message } = policy.walletMessage(typed);
    const signature = await wallet.signTypedData(domain, WALLET_TYPES, message);
    record.add(t);
    log(`[signer] signed AgentWalletSet agent ${message.agentId} deadline ${message.deadline}`);
    return { result: signature };
  }

  async function handle(req, res) {
    const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!allowFrom.has(from)) { res.statusCode = 403; return res.end(); }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { res.statusCode = 413; return res.end(); }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const t = now();
    const bad = authProblem(secret, req.headers[HEADER], body, t, seen);
    if (bad) { log(`[signer] refused a request from ${from}: ${bad}`); res.statusCode = 401; return res.end(); }

    let id = null;
    try {
      const { id: rid, method, params = [] } = JSON.parse(body);
      id = rid ?? null;
      if (method === 'eth_accounts') return answer(res, id, [wallet.address]);
      if (method === 'eth_chainId') return answer(res, id, ethers.toQuantity(chainId));
      if (!['eth_signTransaction', 'eth_signTypedData_v4', 'eth_signTypedData'].includes(method)) return answer(res, id, null, `${method} is not offered`);
      // One signature at a time, so the cap and the nonce are judged against what came before.
      const done = busy.then(() => sign(method, params, t));
      busy = done.catch(() => {});
      const { result, error } = await done;
      return answer(res, id, result, error);
    } catch (err) {
      return answer(res, id, null, `bad request: ${err.message}`);
    }
  }

  // A request that fails part way, such as a client that hangs up mid-body, ends that request and
  // not the process.
  return function (req, res) {
    req.on('error', () => {});
    handle(req, res).catch((err) => {
      log(`[signer] request failed: ${err.message}`);
      if (!res.headersSent) { res.statusCode = 400; res.end(); } else res.destroy();
    });
  };
}

/**
 * The server: connections from anywhere but SIGNER_ALLOW_FROM are dropped before a byte is read,
 * and the rest get little time and little room.
 */
function createServer(handler, allowFrom) {
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, handler);
  server.maxConnections = 16;
  server.keepAliveTimeout = 2_000;
  server.on('connection', (socket) => {
    if (!allowFrom.has(String(socket.remoteAddress || '').replace(/^::ffff:/, ''))) socket.destroy();
  });
  return server;
}

// A secret file readable by anyone but its owner is refused: the host is shared. (Windows reports
// no POSIX modes; the signer runs on Linux.)
function privateFile(file, platform = process.platform) {
  if (platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by others; make it 0400 or 0600`);
  return file;
}

function readConfig(env = process.env) {
  const need = (name) => {
    const v = String(env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const allowFrom = new Set(need('SIGNER_ALLOW_FROM').split(',').map((x) => x.trim()).filter(Boolean));
  // A cap that does not parse would compare false against everything, and so be no cap.
  const whole = (name, fallback, min) => {
    const n = Number(String(env[name] ?? '').trim() || fallback);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`);
    return n;
  };
  return {
    keystore: need('SIGNER_KEYSTORE'),
    passwordFile: need('SIGNER_PASSWORD_FILE'),
    secretFile: need('SIGNER_SECRET_FILE'),
    stateFile: String(env.SIGNER_STATE_FILE || '/data/signer-state.json'),
    rpcUrl: need('SIGNER_RPC_URL'),
    host: String(env.SIGNER_HOST || '0.0.0.0'),
    port: whole('SIGNER_PORT', 28600, 1),
    allowFrom,
    chainId: whole('SIGNER_CHAIN_ID', 5042002, 1),
    reputationRegistry: ethers.getAddress(env.SIGNER_REPUTATION_REGISTRY || '0x8004B663056A597Dffe9eCcC1965A193B7388713'),
    identityRegistry: ethers.getAddress(env.SIGNER_IDENTITY_REGISTRY || '0x8004A818BFB912233c491871b3d84c89A494BD9e'),
    agentId: String(whole('SIGNER_AGENT_ID', 897764, 0)),
    agentOwner: ethers.getAddress(need('SIGNER_AGENT_OWNER')),
    maxGas: BigInt(whole('SIGNER_MAX_GAS', 400_000, 21_000)),
    maxFeeWei: ethers.parseUnits(need('SIGNER_MAX_FEE_GWEI'), 'gwei'),
    maxPerHour: whole('SIGNER_MAX_PER_HOUR', 60, 1),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === 'new-keystore') {
    const target = argv[1];
    if (!target) throw new Error('usage: node signer.js new-keystore <path>');
    if (fs.existsSync(target)) throw new Error(`${target} already exists; not overwritten`);
    const password = fs.readFileSync(privateFile(String(env.SIGNER_PASSWORD_FILE || '')), 'utf8').trim();
    if (password.length < 32) throw new Error('SIGNER_PASSWORD_FILE must hold at least 32 characters');
    const wallet = ethers.Wallet.createRandom();
    fs.writeFileSync(target, await wallet.encrypt(password), { mode: 0o400, flag: 'wx' });
    console.log(wallet.address);
    return;
  }
  const cfg = readConfig(env);
  const password = fs.readFileSync(privateFile(cfg.passwordFile), 'utf8').trim();
  const wallet = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(privateFile(cfg.keystore), 'utf8'), password);
  const secret = readSecret(privateFile(cfg.secretFile));
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const chain = async () => {
    const [pendingNonce, block] = await Promise.all([provider.getTransactionCount(wallet.address, 'pending'), provider.getBlock('latest')]);
    return { pendingNonce, time: Number(block.timestamp) };
  };
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  const policy = createPolicy({ ...cfg, address: wallet.address });
  const handler = createSigner({
    wallet, policy, secret, allowFrom: cfg.allowFrom, maxPerHour: cfg.maxPerHour, chainId: cfg.chainId, chain, record: signedRecord(cfg.stateFile),
  });
  createServer(handler, cfg.allowFrom).listen(cfg.port, cfg.host, () => {
    console.log(`[signer] ${wallet.address} on ${cfg.host}:${cfg.port}, from ${[...cfg.allowFrom].join(', ')}, at most ${cfg.maxPerHour} an hour`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[signer] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createPolicy, createSigner, createServer, signedRecord, privateFile, readConfig, main, MAX_DEADLINE_DELAY };
