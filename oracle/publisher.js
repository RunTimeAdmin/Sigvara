'use strict';

/**
 * ERC-8004 publisher (docs/adr/0008-sigvara-as-erc8004-signal-provider.md).
 *
 * Publishes the spendable score of each Sigvara agent linked on chain to the ERC-8004 Reputation
 * Registry as feedback tagged `sigvara` / `score`, from one publisher address that Sigvara names as
 * the agentWallet of its own ERC-8004 registration. Catalogs that filter feedback by a trusted
 * client can then show the score with no integration of their own.
 *
 * It reads the chain only, never oracle state: finalized scores from SigvaraReputation's
 * ReputationUpdated and ReputationZeroed, and links with the same scanner and rules the oracle
 * uses (link-scan.js). It runs beside the primary, and only there: a second copy would be a second
 * provider, or race the first for nonces.
 *
 * PUBLISH_MODE=shadow (the default) reads everything and logs and records each post it would
 * make, with no key and no transaction. PUBLISH_MODE=live posts, through a remote signer on
 * another host, and only while every gate in publisher-policy.liveGateProblems passes.
 *
 *   node publisher.js
 */

require('./config').requireValidNumericConfig('publisher');

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const policy = require('./publisher-policy');
const { createLinkScanner } = require('./link-scan');
const signerAuth = require('./signer-auth');

const REPUTATION_EVENTS = [
  'event ReputationUpdated(bytes32 indexed didHash, uint8 totalScore, uint256 timestamp, bytes32 evidenceRoot)',
  'event ReputationZeroed(bytes32 indexed didHash)',
];
const SCORE_ABI = [
  'function getTotalScore(bytes32 didHash) view returns (uint8)',
  'function getEarnedScore(bytes32 didHash) view returns (uint8)',
  ...REPUTATION_EVENTS,
];
const FEEDBACK_ABI = [
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
];
const WALLET_ABI = ['function getAgentWallet(uint256 agentId) view returns (address)'];
const ZERO = /^0x0{40}$/i;

/**
 * The publisher's cycle, over injected reads and an injected sender so it can be tested without a
 * chain. See the bottom of this file for the real ones.
 *
 * deps:
 *   cfg      { mode, chainId, identityRegistry, reputation, publisher, sigvaraAgentId, fromBlock,
 *              chunkSize, maxTxsPerRun, allowAgentIds (Set or null), minBalance (bigint) }
 *   chain    getAgentInfo(didHash, blockTag)
 *   scanner  a link-scan.js scanner over the publisher's own state
 *   reads    head(), blockTime(block), reputationEvents(from, to), spendable(didHash, block),
 *            earned(didHash, block), agentWallet(agentId), liveFeedback(agentId, client), balance(),
 *            pendingTxs()
 *   signer   address() (null when it does not answer), send(kind, agentId, args) -> tx hash.
 *            Unused in shadow mode, which needs none.
 *   state    get(), set(state), persist()
 */
function createPublisher({ cfg, chain, scanner, reads, signer, state, log = console.log }) {
  const blank = () => ({
    mode: cfg.mode, eventCursor: null, pending: {}, tracked: [], lastRefreshDay: null,
    posted: {}, postedBy: {}, shadowPosted: {}, shadowPostedBy: {}, shadow: [],
  });
  // Folds the reputation events since the last run into `pending`, newest per agent.
  async function foldEvents(s, head) {
    const cursor = s.eventCursor ?? { block: cfg.fromBlock, logIndex: 0 };
    for (let start = cursor.block; start <= head; start += cfg.chunkSize) {
      const end = Math.min(start + cfg.chunkSize - 1, head);
      for (const e of await reads.reputationEvents(start, end)) {
        if (e.block < cursor.block || (e.block === cursor.block && e.logIndex < cursor.logIndex)) continue;
        s.pending[e.didHash] = { kind: e.kind, txHash: e.txHash, block: e.block, evidenceRoot: e.evidenceRoot ?? null };
        if (!s.tracked.includes(e.didHash)) s.tracked.push(e.didHash);
      }
      s.eventCursor = { block: end + 1, logIndex: 0 };
    }
  }

  /** One cycle. Returns what it did, for the log and for tests. */
  async function runOnce() {
    const sigvaraAgent = policy.agentKey(cfg.sigvaraAgentId);
    const allowed = cfg.allowAgentIds ? new Set([...cfg.allowAgentIds].map(policy.agentKey)) : null;
    const s = { ...blank(), ...(state.get() ?? {}) };
    // A switch between shadow and live reads every agent again at once, so the first live run does
    // not wait for the next day's refresh.
    if (s.mode !== cfg.mode) { s.mode = cfg.mode; s.lastRefreshDay = null; }
    const head = await reads.head();
    const readAt = { block: head, time: await reads.blockTime(head) };
    const out = { planned: [], sent: [], skipped: [], blocked: [] };

    const linkedNow = new Set();
    try {
      // No further than the block this run reads at, so every link it uses was checked against
      // the same chain the run reads.
      const found = await scanner.scan({ upTo: head, onClaim: (claim) => linkedNow.add(claim.didHash) });
      if (found) log(`[publisher] ${found} link(s) made on chain found`);
    } catch (err) {
      log(`[publisher] link scan failed: ${err.message}`);
    }

    // An agent's first link is a reason to read it now, not at the next daily refresh, which could
    // be most of a day away. Only an agent that has been scored has anything to post. A link that
    // moves is left to the refresh, so re-linking to fresh 8004 agents all day cannot make the
    // publisher pay for a revoke and a post each time. Saved at once: the scan has already moved
    // past these links, and will not hand them over again.
    const postedByNow = cfg.mode === 'shadow' ? s.shadowPostedBy : s.postedBy;
    for (const didHash of linkedNow) {
      if (s.tracked.includes(didHash) && postedByNow[didHash] === undefined) {
        s.pending[didHash] ??= { kind: 'linked', txHash: null, block: null, evidenceRoot: null };
      }
    }
    if (linkedNow.size) persistAs(s);
    await foldEvents(s, head);

    // Once per UTC day, every agent ever scored is read again: a rise is released over days, and
    // no event says so.
    const today = policy.utcDay(readAt.time);
    if (s.lastRefreshDay !== today) {
      for (const didHash of s.tracked) s.pending[didHash] ??= { kind: 'refresh', txHash: null, block: null, evidenceRoot: null };
      s.lastRefreshDay = today;
    }

    // In live mode, nothing is sent until every gate passes. In shadow mode the gates are reported,
    // so it is plain what would stop a switch to live.
    const gates = policy.liveGateProblems({
      publisher: cfg.publisher,
      agentWallet: await reads.agentWallet(cfg.sigvaraAgentId),
      signerAddress: cfg.mode === 'live' ? await signer.address() : cfg.publisher,
      balance: await reads.balance(),
      minBalance: cfg.minBalance,
      pendingTxs: cfg.mode === 'live' ? await reads.pendingTxs() : 0,
    });
    if (gates.length) {
      out.blocked = gates;
      log(`[publisher] ${cfg.mode === 'live' ? 'posting blocked' : 'live mode would be blocked'}: ${gates.join('; ')}`);
    }
    const sending = cfg.mode === 'live' && gates.length === 0;
    // In shadow mode, what live mode would have posted is kept apart from what was really posted,
    // so the shadow log follows the same daily limit and unchanged rule live mode would. A live run
    // that is blocked reads the real records and writes none, so it loses no pending update.
    const simulating = cfg.mode === 'shadow';
    const recording = sending || simulating;
    const posted = simulating ? s.shadowPosted : s.posted;
    const postedBy = simulating ? s.shadowPostedBy : s.postedBy;

    // Every link up to the read block must be known, or an agent could be posted to the wrong id.
    if (!scanner.covers(head)) {
      log(`[publisher] the link scan has not reached block ${head}; nothing is posted this run`);
      persistAs(s);
      return out;
    }

    // Records that what is live on an 8004 agent, or may be by now, is this agent's score, so a later
    // unlink or slash knows where to clean up. The day stays as it was: only a post this run saw
    // confirmed starts a new day's limit.
    const claim = (agentId, didHash, value) => {
      postedBy[didHash] = agentId;
      if (posted[agentId]?.didHash !== didHash) posted[agentId] = { didHash, day: posted[agentId]?.day, value, block: head };
    };

    let txs = 0;
    const sendFailed = (err) => Object.assign(err, { sendFailed: true });
    // Sends one agent's revokes and post, or, when not sending, records them. Every transaction
    // counts against the per-run cap and is preceded by a balance check. Returns false when the
    // cap would be passed, and nothing is sent for that agent.
    async function apply(agentId, plan, entry, postArgs) {
      if (!sending) {
        const what = { ...entry, revokes: plan.revoke.length, post: plan.post };
        out.planned.push(what);
        s.shadow = [...s.shadow, { ...what, at: readAt.time }].slice(-50);
        log(`[publisher] ${cfg.mode === 'live' ? 'would send (blocked)' : 'shadow'}: agent ${agentId}` +
          `${plan.post ? ` ← ${entry.value}` : ''}${plan.revoke.length ? `, revoking ${plan.revoke.length}` : ''}` +
          ` (${entry.didHash.slice(0, 10)}…, ${entry.reason})`);
        return true;
      }
      if (txs + plan.revoke.length + (plan.post ? 1 : 0) > cfg.maxTxsPerRun) return false;
      const send = async (kind, args) => {
        if (await reads.balance() < cfg.minBalance) throw sendFailed(new Error('the publisher\'s balance fell below the floor'));
        txs += 1;
        try { return await signer.send(kind, agentId, args); } catch (err) { throw sendFailed(err); }
      };
      for (const index of plan.revoke) {
        const tx = await send('revoke', [agentId, index]);
        log(`[publisher] revoked #${index} on agent ${agentId} tx=${tx}`);
      }
      if (plan.post) {
        // Before the send: one that times out can still land, and the agent may unlink before the next run.
        claim(agentId, entry.didHash, entry.value);
        const tx = await send('post', postArgs);
        log(`[publisher] posted ${entry.value} to agent ${agentId} tx=${tx}`);
        out.sent.push({ ...entry, tx });
      }
      return true;
    }

    const fileFor = (agentId, didHash, spendable, earned, why) => policy.encodeFeedback(policy.feedbackFile({
      chainId: cfg.chainId, identityRegistry: cfg.identityRegistry, agentId, publisher: cfg.publisher,
      readAt, spendable, earned, didHash, reputation: cfg.reputation, event: why.kind === 'updated' || why.kind === 'zeroed' ? why : null,
    }));
    const postArgsFor = (agentId, value, file) => [agentId, value, 0, policy.TAG1, policy.TAG2, '', file.uri, file.hash];

    const order = Object.entries(s.pending).sort(([, a], [, b]) => (a.block ?? Infinity) - (b.block ?? Infinity));
    for (const [didHash, why] of order) {
      const skip = (reason) => { out.skipped.push({ didHash, reason }); delete s.pending[didHash]; };
      const done = () => { if (recording) delete s.pending[didHash]; };
      try {
        const zeroed = why.kind === 'zeroed';
        const { operator } = await chain.getAgentInfo(didHash, head);
        const registered = !ZERO.test(String(operator));
        const linked = registered ? await scanner.claimedAgentAt(didHash, operator, head) : undefined;
        const agentId = linked === undefined ? undefined : policy.agentKey(linked);

        // The link moved or ended since the last post. The old 8004 agent must not keep this
        // agent's score: it is revoked there, or, after a slash, set to 0 there whatever the link
        // says now, so clearing the key cannot keep a slashed score showing. Only while the last
        // score posted there is still this agent's: once the 8004 agent names another Sigvara agent
        // and has been posted to for it, what is live there is that agent's, and is left alone.
        const prev = postedBy[didHash];
        if (prev !== undefined && prev !== agentId) {
          if (posted[prev]?.didHash === didHash) {
            const earned = zeroed ? Number(await reads.earned(didHash, head)) : 0;
            const plan = policy.planUpdate(zeroed ? 0 : null, await reads.liveFeedback(prev, cfg.publisher));
            const entry = { didHash, agentId: prev, value: zeroed ? 0 : null, earned, block: head, reason: `${why.kind}, no longer linked` };
            if (plan.revoke.length || plan.post) {
              if (!(await apply(prev, plan, entry, postArgsFor(prev, 0, fileFor(prev, didHash, 0, earned, why))))) break;
            }
            if (recording && plan.post) posted[prev] = { didHash, day: today, value: 0, block: head };
          }
          if (recording) delete postedBy[didHash];
        }

        if (!registered) { skip('not registered'); continue; }
        if (agentId === undefined) { skip('not linked on chain'); continue; }
        if (agentId === sigvaraAgent) { skip("Sigvara's own registration"); continue; }
        if (allowed && !allowed.has(agentId)) { skip('not on PUBLISH_ALLOW_AGENT_IDS'); continue; }
        if (!policy.mayPostNow(posted[agentId]?.day, readAt.time, zeroed)) continue; // tomorrow

        const spendable = Number(await reads.spendable(didHash, head));
        const earned = Number(await reads.earned(didHash, head));
        let live = await reads.liveFeedback(agentId, cfg.publisher);
        if (simulating && live.length === 0 && posted[agentId]?.value !== undefined) {
          live = [{ index: null, value: posted[agentId].value, valueDecimals: 0 }];
        }
        const plan = policy.planUpdate(spendable, live);
        if (!plan.post && !plan.revoke.length) {
          // It is there, though this state does not say so: a post that timed out and landed later, or a
          // state file that was lost. A simulated run has claimed it already, or has nothing to claim.
          if (sending) claim(agentId, didHash, spendable);
          skip(`unchanged at ${spendable}`);
          continue;
        }

        const entry = { didHash, agentId, value: spendable, earned, block: head, reason: why.kind };
        if (!(await apply(agentId, plan, entry, postArgsFor(agentId, spendable, fileFor(agentId, didHash, spendable, earned, why))))) break;
        if (recording && plan.post) {
          posted[agentId] = { didHash, day: today, value: spendable, block: head };
          postedBy[didHash] = agentId;
        }
        done();
      } catch (err) {
        // Left pending, and tried again next run. A failed send stops the run: the next agent's
        // would most likely fail the same way, after its revoke had already gone out.
        log(`[publisher] ${didHash.slice(0, 10)}… not published this run: ${err.message}`);
        if (err.sendFailed) break;
      }
    }
    persistAs(s);
    return out;
  }

  function persistAs(s) {
    state.set(s);
    state.persist();
  }

  return { runOnce };
}

// ---- the real reads, signer and state ---------------------------------------

/**
 * A remote signer speaking Ethereum JSON-RPC (eth_accounts, eth_signTransaction), such as
 * Web3Signer in front of a KMS or HSM, on another host. The key never reaches this process. Each
 * signed transaction is decoded and checked against what was asked before it is broadcast.
 */
function remoteSigner({ url, secret, publisher, provider, chainId, to, maxFeeWei, maxGas, waitMs = 120_000 }) {
  const iface = new ethers.Interface(FEEDBACK_ABI);
  let id = 0;
  async function rpc(method, params) {
    // Signed with the secret both hosts hold (signer-auth.js), so the signer can tell this request
    // from one changed or replayed on the way.
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', [signerAuth.HEADER]: signerAuth.authHeader(secret, body) },
    });
    if (res.status !== 200) throw new Error(`signer ${method}: HTTP ${res.status}`);
    const reply = await res.json();
    if (reply.error) throw new Error(`signer ${method}: ${reply.error.message || JSON.stringify(reply.error)}`);
    return reply.result;
  }
  return {
    async address() {
      try {
        const accounts = (await rpc('eth_accounts', [])).map((a) => a.toLowerCase());
        return accounts.includes(publisher.toLowerCase()) ? publisher : (accounts[0] ?? null);
      } catch { return null; }
    },
    async send(kind, _agentId, args) {
      const data = kind === 'revoke'
        ? iface.encodeFunctionData('revokeFeedback', args)
        : iface.encodeFunctionData('giveFeedback', args);
      const fee = await provider.getFeeData();
      const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
      if (maxFeePerGas > maxFeeWei) throw new Error(`fee ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei is above PUBLISH_MAX_FEE_GWEI`);
      const tip = fee.maxPriorityFeePerGas ?? maxFeePerGas;
      const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
      const gasLimit = (await provider.estimateGas({ from: publisher, to, data })) * 12n / 10n;
      if (gasLimit > maxGas) throw new Error(`gas ${gasLimit} is above PUBLISH_MAX_GAS ${maxGas}`);
      const nonce = await provider.getTransactionCount(publisher, 'pending');
      // The transaction this process will broadcast, and nothing else: an EIP-1559 call to the
      // registry with no value, at these fees, this gas and this nonce. A signer that returns any
      // other (more value or gas, higher fees, another type, an EIP-7702 delegation) is refused.
      const expected = ethers.Transaction.from({
        type: 2, to, data, nonce, gasLimit, chainId: BigInt(chainId), value: 0n, maxFeePerGas, maxPriorityFeePerGas,
      });
      const hex = (n) => ethers.toQuantity(n);
      const ask = {
        from: publisher, to, data, nonce: hex(nonce), gas: hex(gasLimit), chainId: hex(chainId), value: '0x0', type: '0x2',
        maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(maxPriorityFeePerGas),
      };
      const raw = await rpc('eth_signTransaction', [ask]);
      const signed = ethers.Transaction.from(typeof raw === 'string' ? raw : raw.raw);
      if (signed.unsignedHash !== expected.unsignedHash || signed.from?.toLowerCase() !== publisher.toLowerCase()) {
        throw new Error('the signer returned a transaction other than the one asked for; not sent');
      }
      const sent = await provider.broadcastTransaction(signed.serialized);
      const receipt = await provider.waitForTransaction(sent.hash, 1, waitMs);
      if (!receipt || receipt.status !== 1) throw new Error(`${kind} ${sent.hash} did not confirm`);
      return sent.hash;
    },
  };
}

/** A JSON state file, written whole to a temporary name and renamed over the old one. */
function fileState(file) {
  let current = null;
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return {
    get: () => current,
    set: (s) => { current = s; },
    persist: () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(`${file}.tmp`, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(current));
        // Flushed before the rename, so a crash leaves the old file or the new one, never an empty one.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

function readConfig(env = process.env) {
  const need = (name) => {
    const v = String(env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const address = (name) => {
    const v = need(name);
    if (!ethers.isAddress(v)) throw new Error(`${name} is not an address`);
    return ethers.getAddress(v);
  };
  const hexSecret = (v) => {
    if (!/^[0-9a-f]{64,}$/i.test(v)) throw new Error('PUBLISH_SIGNER_SECRET must be at least 32 bytes of hex');
    return v;
  };
  const mode = String(env.PUBLISH_MODE || 'shadow').trim();
  if (!['shadow', 'live'].includes(mode)) throw new Error(`PUBLISH_MODE is "${mode}"; it is shadow or live`);
  const allow = String(env.PUBLISH_ALLOW_AGENT_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    mode,
    rpcUrl: need('RPC_URL'),
    externalRpc: String(env.EXTERNAL_RPC || '').trim() || need('RPC_URL'),
    identityAddress: address('IDENTITY_ADDRESS'),
    reputation: address('REPUTATION_ADDRESS'),
    identityRegistry: address('EXTERNAL_IDENTITY_ADDRESS'),
    feedbackRegistry: address('EXTERNAL_REPUTATION_ADDRESS'),
    linkFromBlock: Number(need('EXTERNAL_LINK_FROM_BLOCK')),
    fromBlock: Number(need('PUBLISH_FROM_BLOCK')),
    sigvaraAgentId: need('SIGVARA_ERC8004_AGENT_ID'),
    // Shadow mode can run before the publisher key exists; its feedback files then name the zero
    // address as the client, and it reads no earlier feedback.
    publisher: mode === 'live' || String(env.PUBLISHER_ADDRESS ?? '').trim() ? address('PUBLISHER_ADDRESS') : ethers.ZeroAddress,
    chunkSize: Number(env.LOG_CHUNK_SIZE || 2000),
    pollSeconds: Number(env.POLL_SECONDS || 300),
    statePath: String(env.PUBLISH_STATE_PATH || '/data/publisher-state.json'),
    maxTxsPerRun: Number(env.PUBLISH_MAX_TXS_PER_RUN || 20),
    allowAgentIds: allow.length ? new Set(allow) : null,
    minBalance: ethers.parseEther(String(env.PUBLISH_MIN_BALANCE || '0.5')),
    // Live mode only.
    signerUrl: mode === 'live' ? need('PUBLISH_SIGNER_URL') : '',
    // The HMAC secret shared with the signer, as hex (signer-auth.js).
    signerSecret: mode === 'live' ? hexSecret(need('PUBLISH_SIGNER_SECRET')) : '',
    maxFeeWei: mode === 'live' ? ethers.parseUnits(need('PUBLISH_MAX_FEE_GWEI'), 'gwei') : 0n,
    maxGas: BigInt(env.PUBLISH_MAX_GAS || 400_000),
  };
}

async function main() {
  let cfg;
  try { cfg = readConfig(); } catch (err) {
    console.error(`[publisher] ${err.message}`);
    process.exit(1);
  }
  const chain = require('./chain');
  const external = require('./external');
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  // The chain module's reads, with no key: the provider stands in for its wallet.
  chain.init({ rpcUrl: cfg.rpcUrl, identityAddress: cfg.identityAddress, reputationAddress: cfg.reputation }, { provider, wallet: provider });
  external.init({ externalRpc: cfg.externalRpc, externalIdentity: cfg.identityRegistry, externalReputation: cfg.feedbackRegistry });
  const chainId = Number((await provider.getNetwork()).chainId);
  const externalChainId = await external.refreshChainId();
  if (externalChainId !== chainId) {
    console.error(`[publisher] the ERC-8004 registry reads as chain ${externalChainId}, not ${chainId}; links are read only from a registry on the scored chain`);
    process.exit(1);
  }

  const store = fileState(cfg.statePath);
  const linkState = {
    get: () => store.get()?.linkScanState ?? null,
    set: (ls) => store.set({ ...(store.get() ?? {}), linkScanState: ls }),
  };
  const scanner = createLinkScanner({
    chain, external, fromBlock: cfg.linkFromBlock, chunkSize: cfg.chunkSize,
    getState: linkState.get, setState: linkState.set, persist: store.persist,
  });
  const scores = new ethers.Contract(cfg.reputation, SCORE_ABI, provider);
  const feedback = new ethers.Contract(cfg.feedbackRegistry, FEEDBACK_ABI, provider);
  const wallets = new ethers.Contract(cfg.identityRegistry, WALLET_ABI, provider);
  const at = (block) => ({ blockTag: block });
  const topics = [['ReputationUpdated', 'ReputationZeroed'].map((name) => scores.interface.getEvent(name).topicHash)];
  const reads = {
    head: () => chain.readWithBackoff('head', () => provider.getBlockNumber()),
    blockTime: async (block) => Number((await chain.readWithBackoff('block', () => provider.getBlock(block))).timestamp),
    reputationEvents: async (from, to) => {
      const logs = await chain.readWithBackoff('reputation logs', () => provider.getLogs({ address: cfg.reputation, topics, fromBlock: from, toBlock: to }));
      return logs.map((l) => {
        const parsed = scores.interface.parseLog(l);
        return {
          kind: parsed.name === 'ReputationZeroed' ? 'zeroed' : 'updated',
          didHash: parsed.args.didHash.toLowerCase(), block: l.blockNumber, logIndex: l.index, txHash: l.transactionHash,
          evidenceRoot: parsed.name === 'ReputationUpdated' ? parsed.args.evidenceRoot : null,
        };
      });
    },
    spendable: (didHash, block) => chain.readWithBackoff('getTotalScore', () => scores.getTotalScore(didHash, at(block))),
    earned: (didHash, block) => chain.readWithBackoff('getEarnedScore', () => scores.getEarnedScore(didHash, at(block))),
    agentWallet: async (agentId) => {
      try { return await chain.readWithBackoff('getAgentWallet', () => wallets.getAgentWallet(agentId)); } catch { return null; }
    },
    // The publisher's live sigvara/score feedback among the last LOOKBACK it gave the agent, newest
    // first. Every update reads these first and revokes all but one, so none older can be live.
    liveFeedback: async (agentId, client) => {
      const last = Number(await chain.readWithBackoff('getLastIndex', () => feedback.getLastIndex(agentId, client)));
      const live = [];
      for (let i = last; i >= 1 && i > last - policy.LOOKBACK; i--) {
        const f = await chain.readWithBackoff('readFeedback', () => feedback.readFeedback(agentId, client, i));
        if (!f.isRevoked && f.tag1 === policy.TAG1 && f.tag2 === policy.TAG2) live.push({ index: i, value: f.value, valueDecimals: f.valueDecimals });
      }
      return live;
    },
    balance: () => chain.readWithBackoff('balance', () => provider.getBalance(cfg.publisher)),
    pendingTxs: async () => {
      const [pending, latest] = await Promise.all([
        chain.readWithBackoff('nonce', () => provider.getTransactionCount(cfg.publisher, 'pending')),
        chain.readWithBackoff('nonce', () => provider.getTransactionCount(cfg.publisher, 'latest')),
      ]);
      return pending - latest;
    },
  };
  const signer = cfg.mode === 'live'
    ? remoteSigner({ url: cfg.signerUrl, secret: cfg.signerSecret, publisher: cfg.publisher, provider, chainId, to: cfg.feedbackRegistry, maxFeeWei: cfg.maxFeeWei, maxGas: cfg.maxGas })
    : null;

  // One file, two writers: the cycle's state and the link scan's. Each writes only its own part,
  // or the cycle, saving the copy it read at the start of a run, would undo the scan's checkpoint.
  const publisher = createPublisher({
    cfg: { ...cfg, chainId }, chain, scanner, reads, signer,
    state: {
      get: () => {
        const { linkScanState: _ls, ...rest } = store.get() ?? {};
        return Object.keys(rest).length ? rest : null;
      },
      set: (s) => store.set({ ...s, linkScanState: store.get()?.linkScanState ?? null }),
      persist: store.persist,
    },
  });
  console.log(`[publisher] ${cfg.mode} mode, as ${cfg.publisher}, every ${cfg.pollSeconds}s, Sigvara's ERC-8004 agent ${cfg.sigvaraAgentId}`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await publisher.runOnce();
      const why = {};
      for (const s of r.skipped) why[s.reason] = (why[s.reason] ?? 0) + 1;
      const reasons = Object.entries(why).map(([reason, n]) => `${reason}: ${n}`).join(', ');
      console.log(`[publisher] run: ${r.planned.length} planned, ${r.sent.length} sent, ${r.skipped.length} skipped${reasons ? ` (${reasons})` : ''}`);
    } catch (err) {
      console.error(`[publisher] run failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, cfg.pollSeconds * 1000);
}

if (require.main === module) main();

module.exports = { createPublisher, remoteSigner, readConfig, fileState };
