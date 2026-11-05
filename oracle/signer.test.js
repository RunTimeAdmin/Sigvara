'use strict';

// The publisher's policy signer (signer.js) and the authentication between them (signer-auth.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { ethers } = require('ethers');
const { HEADER, authHeader, authProblem } = require('./signer-auth');
const { createPolicy, createSigner, createServer, signedRecord, privateFile, readConfig, main } = require('./signer');
const { remoteSigner } = require('./publisher');
const { feedbackFile, encodeFeedback } = require('./publisher-policy');
const { agentWalletTypedData, requestSignature } = require('./agent-wallet');

const SECRET = 'cd'.repeat(32);
const REP = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const ID = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const OWNER = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
const CHAIN = 5042002;
const NOW = 1_793_740_000;
const iface = new ethers.Interface([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
  'function transfer(address to, uint256 amount)',
]);

// ---- authentication -------------------------------------------------------------------

test('authProblem: the right MAC on the same body, once, inside the window', () => {
  const seen = new Map();
  const body = '{"a":1}';
  const h = authHeader(SECRET, body, 1000);
  assert.equal(authProblem(SECRET, h, body, 1010, seen), null);
  assert.match(authProblem(SECRET, h, body, 1011, seen), /already seen/, 'a replay is refused');
  assert.match(authProblem(SECRET, authHeader(SECRET, body, 1000), '{"a":2}', 1010, new Map()), /does not match/, 'a changed body is refused');
  assert.match(authProblem('ef'.repeat(32), authHeader(SECRET, body, 1000), body, 1010, new Map()), /does not match/, 'another secret is refused');
  assert.match(authProblem(SECRET, authHeader(SECRET, body, 1000), body, 1100, new Map()), /too old/);
  assert.match(authProblem(SECRET, undefined, body, 1000, new Map()), /no or malformed/);
});

// ---- the policy -----------------------------------------------------------------------

const KEY = ethers.Wallet.createRandom();
const policy = createPolicy({
  address: KEY.address, chainId: CHAIN, reputationRegistry: REP, identityRegistry: ID, agentId: '897764', agentOwner: OWNER,
  maxGas: 400_000n, maxFeeWei: 50n * 10n ** 9n,
});
const CHAIN_NOW = { pendingNonce: 4, time: NOW };
const FILE = Buffer.from('{"value":47}');
const DATA = `data:application/json;base64,${FILE.toString('base64')}`;
const HASH = ethers.keccak256(FILE);
const post = (o = {}) => iface.encodeFunctionData('giveFeedback', [
  o.agentId ?? 7, o.value ?? 47, o.decimals ?? 0, o.tag1 ?? 'sigvara', o.tag2 ?? 'score', o.endpoint ?? '', o.uri ?? DATA, o.hash ?? HASH,
]);
const tx = (o = {}) => ({
  from: KEY.address, to: REP, data: post(), nonce: '0x4', gas: '0x2bf20', chainId: ethers.toQuantity(CHAIN), value: '0x0', type: '0x2',
  maxFeePerGas: ethers.toQuantity(20n * 10n ** 9n), maxPriorityFeePerGas: ethers.toQuantity(10n ** 9n), ...o,
});
const wallet = (o = {}) => {
  const typed = agentWalletTypedData({ chainId: CHAIN, registry: ID, agentId: 897764, newWallet: KEY.address, owner: OWNER, deadline: NOW + 240 });
  return { ...typed, ...o, message: { ...typed.message, ...(o.message ?? {}) }, domain: { ...typed.domain, ...(o.domain ?? {}) } };
};

test('policy: a sigvara/score post and a revoke on the Reputation Registry, at the next nonce, are allowed', () => {
  assert.equal(policy.transaction(tx(), CHAIN_NOW), null);
  assert.equal(policy.transaction(tx({ data: iface.encodeFunctionData('revokeFeedback', [7, 1]) }), CHAIN_NOW), null);
  assert.equal(policy.transaction(tx({ data: post({ value: 0 }) }), CHAIN_NOW), null, 'a zero after a slash');
});

test('policy: anything else is refused, each for its own reason', () => {
  const refused = {
    'from is not': tx({ from: ethers.Wallet.createRandom().address }),
    'only calls to the ERC-8004 Reputation Registry': tx({ to: ID }),
    'no value': tx({ value: '0x1' }),
    'only type-2': [tx({ type: '0x0' }), tx({ type: '0x4' })],
    'no access list or authorization': [tx({ authorizationList: [{ address: REP }] }), tx({ accessList: [{ address: REP, storageKeys: [] }] })],
    'only chain': tx({ chainId: '0x1' }),
    'gas above': tx({ gas: ethers.toQuantity(500_000) }),
    'fee above the cap': tx({ maxFeePerGas: ethers.toQuantity(60n * 10n ** 9n) }),
    'priority fee above the fee': tx({ maxPriorityFeePerGas: ethers.toQuantity(30n * 10n ** 9n) }),
    'only the next nonce': [tx({ nonce: '0x5' }), tx({ nonce: '0x100000' }), tx({ nonce: undefined })],
    'only giveFeedback or revokeFeedback': tx({ data: iface.encodeFunctionData('transfer', [OWNER, 1]) }),
    'not exactly one call': tx({ data: `${post()}00` }),
    'tagged sigvara/score': tx({ data: post({ tag1: 'starred' }) }),
    'a value of 0 to 100': [tx({ data: post({ value: 101 }) }), tx({ data: post({ value: -1 }) }), tx({ data: post({ decimals: 2 }) })],
    'no endpoint': tx({ data: post({ endpoint: 'https://x' }) }),
    'only a data: feedback URI': tx({ data: post({ uri: 'https://example.com/f.json' }) }),
    'does not hold JSON': tx({ data: post({ uri: 'data:application/json;base64,bm90IGpzb24=' }) }),
    'a feedback hash of the file it comes with': tx({ data: post({ hash: ethers.ZeroHash }) }),
  };
  for (const [reason, cases] of Object.entries(refused)) {
    for (const t of [cases].flat()) assert.match(String(policy.transaction(t, CHAIN_NOW)), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), reason);
  }
});

test('policy: only a current AgentWalletSet for agent 897764, naming this signer, for the registration\'s owner', () => {
  assert.equal(policy.typedData(KEY.address, wallet(), CHAIN_NOW), null);
  const refused = {
    'only agent 897764': wallet({ message: { agentId: '1' } }),
    'only this signer as the new wallet': wallet({ message: { newWallet: OWNER } }),
    "only for the registration's owner": wallet({ message: { owner: '0x000000000000000000000000000000000000dEaD' } }),
    'only a deadline within': [wallet({ message: { deadline: String(NOW + 301) } }), wallet({ message: { deadline: String(NOW - 1) } }), wallet({ message: { deadline: '99999999999' } })],
    'only the ERC-8004 Identity Registry': [wallet({ domain: { verifyingContract: REP } }), wallet({ domain: { chainId: 1 } })],
    'a domain of name, version, chainId and verifyingContract only': wallet({ domain: { salt: ethers.ZeroHash } }),
    'only AgentWalletSet': wallet({ primaryType: 'Permit' }),
  };
  for (const [reason, cases] of Object.entries(refused)) {
    for (const t of [cases].flat()) assert.match(String(policy.typedData(KEY.address, t, CHAIN_NOW)), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), reason);
  }
  assert.match(String(policy.typedData(OWNER, wallet(), CHAIN_NOW)), /not 0x/, 'another signer');
});

test('walletMessage: what is signed is rebuilt from the checked values', () => {
  const { domain, message } = policy.walletMessage(wallet({ message: { extra: 'x' } }));
  assert.deepEqual(Object.keys(domain).sort(), ['chainId', 'name', 'verifyingContract', 'version']);
  assert.deepEqual(Object.keys(message).sort(), ['agentId', 'deadline', 'newWallet', 'owner']);
  assert.equal(message.deadline, BigInt(NOW + 240));
});

test('signedRecord: an hour\'s window, kept across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-signer-'));
  try {
    const file = path.join(dir, 'state.json');
    const r = signedRecord(file);
    r.add(1000);
    r.add(2000);
    assert.equal(signedRecord(file).since(2100), 2, 'a new process reads what the old one signed');
    assert.equal(signedRecord(file).since(4601), 1, 'the first is more than an hour old');
    assert.equal(signedRecord(file).since(5601), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the server, with the publisher and agent-wallet.js as its clients ------------------

async function serve({ allowFrom = new Set(['127.0.0.1']), maxPerHour = 60, warmup = 0, pendingNonce = 4 } = {}) {
  const logs = [];
  const state = { pendingNonce };
  const handler = createSigner({
    wallet: KEY, policy, secret: SECRET, allowFrom, maxPerHour, chainId: CHAIN, warmup, record: signedRecord(null), log: (l) => logs.push(l),
    chain: async () => ({ pendingNonce: state.pendingNonce, time: Math.floor(Date.now() / 1000) }),
  });
  const server = createServer(handler, allowFrom);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, logs, state, close: () => new Promise((r) => server.close(r)) };
}

function fakeProvider(s) {
  const broadcast = [];
  return {
    broadcast,
    getFeeData: async () => ({ maxFeePerGas: 20n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
    estimateGas: async () => 150_000n,
    getTransactionCount: async () => s.state.pendingNonce,
    // Each transaction that lands moves the account's nonce on, as the chain does.
    broadcastTransaction: async (raw) => { broadcast.push(raw); s.state.pendingNonce += 1; return { hash: ethers.Transaction.from(raw).hash }; },
    waitForTransaction: async () => ({ status: 1 }),
  };
}

const client = (s, provider) => remoteSigner({ url: s.url, secret: SECRET, publisher: KEY.address, provider, chainId: CHAIN, to: REP, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n });

test('the publisher signs a revoke and a post through it, and agent-wallet.js gets the AgentWalletSet signature', async () => {
  const s = await serve();
  try {
    const provider = fakeProvider(s);
    const signer = client(s, provider);
    assert.equal(await signer.address(), KEY.address);
    await signer.send('revoke', 7, [7, 1]);
    await signer.send('post', 7, [7, 47, 0, 'sigvara', 'score', '', DATA, HASH]);
    assert.equal(provider.broadcast.length, 2);
    assert.deepEqual(provider.broadcast.map((raw) => ethers.Transaction.from(raw).nonce), [4, 5]);

    const now = Math.floor(Date.now() / 1000);
    const typed = agentWalletTypedData({ chainId: CHAIN, registry: ID, agentId: 897764, newWallet: KEY.address, owner: OWNER, deadline: now + 240 });
    const signature = await requestSignature(s.url, typed, SECRET);
    assert.equal(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature), KEY.address);
    assert.ok(s.logs.some((l) => /signed giveFeedback agent 7 value 47 nonce 5/.test(l)));
  } finally {
    await s.close();
  }
});

test('a request without the secret is turned away, and a stranger\'s connection is dropped before it is read', async () => {
  const s = await serve();
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] });
    assert.equal((await fetch(s.url, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(s.url, { method: 'POST', body, headers: { [HEADER]: authHeader('ef'.repeat(32), body) } })).status, 401);
  } finally {
    await s.close();
  }
  const closed = await serve({ allowFrom: new Set(['10.0.0.1']) });
  try {
    await assert.rejects(fetch(closed.url, { method: 'POST', body: '{}', headers: { [HEADER]: authHeader(SECRET, '{}') } }));
  } finally {
    await closed.close();
  }
});

test('a client that hangs up mid-body costs that request, not the signer', async () => {
  const s = await serve();
  try {
    await new Promise((resolve) => {
      const sock = net.connect(s.port, '127.0.0.1', () => {
        sock.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc":');
        setTimeout(() => { sock.destroy(); resolve(); }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await client(s, fakeProvider(s)).address(), KEY.address, 'still answering');
  } finally {
    await s.close();
  }
});

test('it signs nothing in its first minute, since the record of used requests starts empty', async () => {
  const s = await serve({ warmup: 60 });
  try {
    await assert.rejects(client(s, fakeProvider(s)).send('revoke', 7, [7, 1]), /starting; signing from 60 s after start/);
  } finally {
    await s.close();
  }
});

test('it signs no more than SIGNER_MAX_PER_HOUR an hour, and offers no other method', async () => {
  const s = await serve({ maxPerHour: 1 });
  try {
    const signer = client(s, fakeProvider(s));
    await signer.send('revoke', 7, [7, 1]);
    await assert.rejects(signer.send('revoke', 7, [7, 2]), /no more than 1 signatures an hour/);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{}] });
    const res = await (await fetch(s.url, { method: 'POST', body, headers: { [HEADER]: authHeader(SECRET, body) } })).json();
    assert.match(res.error.message, /not offered/);
  } finally {
    await s.close();
  }
});

test('new-keystore writes an encrypted keystore, prints only its address, and never overwrites one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-signer-'));
  try {
    const passwordFile = path.join(dir, 'password');
    fs.writeFileSync(passwordFile, 'p'.repeat(40), { mode: 0o600 });
    const keystore = path.join(dir, 'keystore.json');
    const printed = [];
    const log = console.log;
    console.log = (line) => printed.push(line);
    try {
      await main(['new-keystore', keystore], { SIGNER_PASSWORD_FILE: passwordFile });
    } finally {
      console.log = log;
    }
    assert.equal(printed.length, 1);
    const w = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(keystore, 'utf8'), 'p'.repeat(40));
    assert.equal(w.address, printed[0]);
    await assert.rejects(main(['new-keystore', keystore], { SIGNER_PASSWORD_FILE: passwordFile }), /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('privateFile: a secret readable by others is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-signer-'));
  try {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    if (process.platform !== 'win32') assert.throws(() => privateFile(file), /readable by others/);
    fs.chmodSync(file, 0o600);
    assert.equal(privateFile(file), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the policy takes what the publisher really builds', () => {
  const { uri, hash } = encodeFeedback(feedbackFile({
    chainId: CHAIN, identityRegistry: ID, agentId: 7, publisher: KEY.address, readAt: { time: NOW, block: 123 },
    spendable: 47, earned: 47, didHash: `0x${'cd'.repeat(32)}`, reputation: REP,
  }));
  assert.equal(policy.transaction(tx({ data: post({ uri, hash }) }), CHAIN_NOW), null);
  assert.match(policy.transaction(tx({ data: post({ uri, hash: ethers.id('another file') }) }), CHAIN_NOW), /a feedback hash/);
});

test('readConfig: listens on this machine alone unless told otherwise', () => {
  const base = {
    SIGNER_KEYSTORE: 'k', SIGNER_PASSWORD_FILE: 'p', SIGNER_SECRET_FILE: 's', SIGNER_ALLOW_FROM: '72.62.41.138', SIGNER_RPC_URL: 'https://r',
    SIGNER_AGENT_OWNER: OWNER, SIGNER_MAX_FEE_GWEI: '50',
  };
  assert.equal(readConfig(base).host, '127.0.0.1');
  assert.equal(readConfig({ ...base, SIGNER_HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('readConfig: a cap that does not parse is refused, not read as no cap', () => {
  const base = {
    SIGNER_KEYSTORE: 'k', SIGNER_PASSWORD_FILE: 'p', SIGNER_SECRET_FILE: 's', SIGNER_ALLOW_FROM: '72.62.41.138', SIGNER_MAX_FEE_GWEI: '50',
    SIGNER_RPC_URL: 'https://rpc.example', SIGNER_AGENT_OWNER: OWNER,
  };
  assert.equal(readConfig(base).maxPerHour, 60);
  assert.throws(() => readConfig({ ...base, SIGNER_MAX_PER_HOUR: 'lots' }), /SIGNER_MAX_PER_HOUR must be a whole number/);
  assert.throws(() => readConfig({ ...base, SIGNER_ALLOW_FROM: '' }), /SIGNER_ALLOW_FROM is required/);
  assert.throws(() => readConfig({ ...base, SIGNER_AGENT_OWNER: '' }), /SIGNER_AGENT_OWNER is required/);
});
