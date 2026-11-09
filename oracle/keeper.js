'use strict';

/**
 * Slash keeper (docs/operations-runbook.md, section 7).
 *
 * An undisputed slash settles only when someone calls executeSlash, and a fortnight after its
 * challenge deadline anyone may let it lapse with expireSlash. Execution is permissionless on
 * purpose, so the committee need not act twice, but that leaves it depending on somebody noticing.
 * This is that somebody. It holds no role and no funds beyond gas: its key can only do what any
 * passer-by can.
 *
 * It reads the chain only: SlashInitiated from the staking contract to learn who to watch, then
 * each proposal. It calls executeSlash only after a simulated call passes, so the contract's own
 * rules decide, and a proposal another keeper has already settled costs nothing.
 *
 * Three things it will not do, each on purpose:
 *   - Execute past the lapse. The contract would still allow it until someone calls expireSlash,
 *     but a slash that has sat a fortnight is a person's decision. It raises an alert instead.
 *   - Expire anything. expireSlash and expireDispute reinstate the agent, which is not a keeper's
 *     call either. It watches for both: a dispute waiting on a ruling, one nobody ruled on, a slash
 *     that lapsed, and any it was watching that someone settled or dropped.
 *   - Execute an agent on KEEPER_SKIP_AGENTS. Live mode refuses to start until that list is said
 *     out loud, because the slash drill leaves a real slash to lapse on purpose.
 *
 * KEEPER_MODE=shadow (the default) reads everything and logs each call it would make, with no
 * transaction. KEEPER_MODE=live sends them. Run two, on separate hosts with separate keys: the
 * backup's KEEPER_GRACE_SECONDS gives the primary the first chance, so only one pays the gas.
 *
 *   node keeper.js
 */

require('./config').requireValidNumericConfig('keeper');

const { ethers } = require('ethers');
const { fileState } = require('./publisher');
const { webhookPayload } = require('./watcher-policy');
const { redact } = require('./event-index');
const { wordsOf } = require('./log-spans');
const { readWithBackoff } = require('./read-retry');

const STAKING_ABI = [
  'event SlashInitiated(bytes32 indexed didHash, address indexed reporter, address indexed victim, uint256 initiatedAt)',
  'function getSlashProposal(bytes32 didHash) view returns (tuple(bytes32 didHash, address reporter, address victim, uint256 initiatedAt, uint8 state, bytes evidenceHash, uint256 challengeDeadline, uint256 disputedAt))',
  'function EXECUTION_PERIOD() view returns (uint256)',
  'function DISPUTE_RESOLUTION_PERIOD() view returns (uint256)',
  'function executeSlash(bytes32 didHash)',
  'error NoActivePendingSlash(bytes32 didHash)',
  'error ChallengePeriodActive(bytes32 didHash, uint256 unlocksAt)',
  'error ReporterNotAuthorized(bytes32 didHash, address reporter)',
];
// SigvaraStaking.SlashState: None, Pending, Executed, Cancelled, Disputed. Only Pending can be
// executed, and no other state returns to it: a slash filed again emits SlashInitiated again.
const PENDING = 1;
const EXECUTED = 2;
const CANCELLED = 3;
const DISPUTED = 4;
// How far behind the newest block the scan stays, about ten seconds of Arc blocks, so a node a
// block or two behind the one that named the head can still answer for the span.
const SCAN_MARGIN = 20;
// An unresolved problem is raised again after this long, so one alert missed is not one forgotten.
const ALERT_AGAIN_SECONDS = 24 * 3600;
// Consecutive failed runs before a person hears about it. One failed read is routine.
const FAILED_RUNS_ALERT = 6;
// Between log reads. Arc's public RPCs refuse a burst of them within a handful of calls (measured 5
// November 2026), and a first run has dozens to make. As the payment scan does.
const SCAN_PACE_MS = 500;
// How long a slash may wait behind a transaction of the keeper's own before a person hears of it.
const BLOCKED_ALERT_SECONDS = 30 * 60;
// The alerts raised about one agent's slash, keyed `<kind>:<didHash>` (refused adds `:<error>`). They
// end with the slash: one left behind would silence the same alert about the next filing.
const AGENT_ALERTS = Object.freeze(['disputed', 'dispute-unruled', 'lapsed', 'refused', 'failed']);

const DID_HASH = /^0x[0-9a-f]{64}$/;

// An error as words that can leave this machine. An ethers error's message holds the whole RPC URL
// when a node answers 429 or 500, and a provider's URL can carry its key. These reach the webhook,
// which is somebody else's channel. The node's own words say what happened.
const said = (err, cfg) => redact(wordsOf(err), [cfg.rpcUrl, cfg.webhookUrl]);

/**
 * What to do about one proposal at chain time nowSec. Pure.
 * cfg: { executionPeriod, disputePeriod (seconds), graceSeconds, skip (Set of lowercase didHash) }
 */
function decide(didHash, proposal, nowSec, cfg) {
  const state = Number(proposal.state);
  if (state === DISPUTED) {
    const expiresAt = Number(proposal.disputedAt) + cfg.disputePeriod;
    return { action: nowSec > expiresAt ? 'dispute-unruled' : 'disputed', expiresAt };
  }
  if (state !== PENDING) return { action: 'forget', state };
  const deadline = Number(proposal.challengeDeadline);
  const lapsesAt = deadline + cfg.executionPeriod;
  if (nowSec <= deadline) return { action: 'wait', until: deadline };
  // Before the skip list: once lapsed, nothing here will execute it, listed or not.
  if (nowSec > lapsesAt) return { action: 'lapsed', lapsesAt };
  if (cfg.skip.has(didHash)) return { action: 'held', lapsesAt };
  if (nowSec <= deadline + cfg.graceSeconds) return { action: 'wait', until: deadline + cfg.graceSeconds };
  return { action: 'execute', lapsesAt };
}

/**
 * The keeper's cycle, over injected reads and an injected sender so it can be tested without a
 * chain. See main() for the real ones.
 *
 * deps:
 *   cfg     { mode, name, fromBlock, chunkSize, graceSeconds, skip, executionPeriod, disputePeriod, minBalance (bigint) }
 *   reads   head(), blockTime(block), slashInitiated(from, to) -> [didHash], proposal(didHash),
 *           simulate(didHash) -> null or the name of the error it reverts with,
 *           balance(), pendingTxs()
 *   sender  send(didHash) -> tx hash; rejects on a failed or unconfirmed transaction. Live mode only.
 *   state   get(), set(s), persist()
 *   notify  (level, title, lines) -> delivered to a person; failure is its own problem
 */
function createKeeper({ cfg, reads, sender, state, notify = async () => {}, log = console.log, pause = () => new Promise((r) => setTimeout(r, SCAN_PACE_MS)) }) {
  let failedRuns = 0;
  const load = () => ({ scanBlock: cfg.fromBlock, open: {}, alerted: {}, executed: {}, ...(state.get() ?? {}) });

  // Once per problem, and again a day later if it is still there.
  async function raise(s, nowSec, key, level, title, lines) {
    if (nowSec - (s.alerted[key] ?? -Infinity) < ALERT_AGAIN_SECONDS) return;
    s.alerted[key] = nowSec;
    await notify(level, title, lines);
  }

  function forgetAlerts(s, didHash) {
    for (const key of Object.keys(s.alerted)) {
      const [kind, d] = key.split(':');
      if (d === didHash && AGENT_ALERTS.includes(kind)) delete s.alerted[key];
    }
  }

  async function runOnce() {
    const s = load();
    const head = await reads.head();
    const safeHead = head - SCAN_MARGIN;

    const firstScanned = s.scanBlock;
    // Who to watch. A filed slash stays open here until it is settled or dropped. The value says
    // whether it has been seen open, so history read on a first run raises no alerts.
    for (let start = s.scanBlock; start <= safeHead; start += cfg.chunkSize) {
      if (start !== firstScanned) await pause();
      const end = Math.min(start + cfg.chunkSize - 1, safeHead);
      for (const didHash of await reads.slashInitiated(start, end)) {
        const d = didHash.toLowerCase();
        s.open[d] = s.open[d] ?? false;
      }
      s.scanBlock = end + 1;
      state.set(s);
      state.persist();
    }

    const nowSec = await reads.blockTime(head);
    const r = { waiting: [], held: [], lapsed: [], disputed: [], refused: [], wouldExecute: [], executed: [], failed: [], blocked: [] };
    for (const didHash of Object.keys(s.open)) {
      const d = decide(didHash, await reads.proposal(didHash), nowSec, cfg);
      if (d.action === 'forget') {
        const watched = s.open[didHash];
        delete s.open[didHash];
        // Ours is reported when it is confirmed. Anything else that ended a slash we were watching
        // is news: another keeper, the committee, the admin, someone expiring it, or a transaction
        // of ours that confirmed after we stopped waiting.
        if (watched && !s.executed[didHash]) {
          if (d.state === EXECUTED) await notify('ok', 'A slash the keeper was watching has been executed', [`agent ${didHash}`, 'Not by a transaction this keeper saw confirm.']);
          if (d.state === CANCELLED) await notify('ok', 'A slash the keeper was watching was dropped', [`agent ${didHash}`, 'Cancelled, vetoed, ruled for the agent, or expired.']);
        }
        delete s.executed[didHash];
        forgetAlerts(s, didHash);
        continue;
      }
      s.open[didHash] = true;
      if (d.action === 'disputed') {
        r.disputed.push({ didHash, expiresAt: d.expiresAt });
        // Once, when it is first seen. The admin has until expiresAt, and a daily alert for a
        // fortnight would teach people to ignore it.
        if (!s.alerted[`disputed:${didHash}`]) {
          await raise(s, nowSec, `disputed:${didHash}`, 'warn', 'A slash was disputed and needs a ruling', [
            `agent ${didHash}`,
            `The admin can rule with resolveDispute until ${new Date(d.expiresAt * 1000).toISOString()}. After that anyone can release it with expireDispute.`,
          ]);
        }
      } else if (d.action === 'dispute-unruled') {
        r.disputed.push({ didHash, expiresAt: d.expiresAt });
        await raise(s, nowSec, `dispute-unruled:${didHash}`, 'warn', 'A disputed slash was never ruled on', [
          `agent ${didHash}`,
          'Its bond stays frozen and the agent Suspended until someone calls expireDispute. The keeper does not.',
        ]);
      } else if (d.action === 'wait') {
        r.waiting.push({ didHash, until: d.until });
      } else if (d.action === 'held') {
        r.held.push({ didHash, lapsesAt: d.lapsesAt });
      } else if (d.action === 'lapsed') {
        r.lapsed.push({ didHash, lapsesAt: d.lapsesAt });
        await raise(s, nowSec, `lapsed:${didHash}`, 'warn', 'A slash lapsed without being executed', [
          `agent ${didHash}`,
          'The keeper does not execute past the lapse or expire anything. Decide what should happen to it.',
        ]);
      } else {
        await act(s, r, didHash, nowSec);
      }
    }

    if (cfg.mode === 'live') {
      const balance = await reads.balance();
      if (balance < cfg.minBalance) {
        await raise(s, nowSec, 'balance', 'warn', 'The slash keeper is low on gas', [`it holds ${ethers.formatEther(balance)}; top it up above ${ethers.formatEther(cfg.minBalance)}`]);
      }
    }
    // Blocked only while a run finds itself blocked, so the next spell gets its own half hour.
    if (!r.blocked.length) {
      delete s.blockedSince;
      delete s.alerted.blocked;
    }
    s.lastRunAt = nowSec;
    state.set(s);
    state.persist();
    failedRuns = 0;
    return { ...r, open: Object.keys(s.open).length, head, nowSec };
  }

  async function act(s, r, didHash, nowSec) {
    const refusal = await reads.simulate(didHash);
    // Someone settled or dropped it between the read and the simulation. The next run forgets it.
    if (refusal === 'NoActivePendingSlash') return;
    if (refusal) {
      r.refused.push({ didHash, reason: refusal });
      await raise(s, nowSec, `refused:${didHash}:${refusal}`, 'warn', 'A slash that should be executable is refused', [
        `agent ${didHash}`,
        `executeSlash reverts with ${refusal}.`,
        refusal === 'ReporterNotAuthorized' ? 'Its reporter has left the committee. A current member can cancel it, or it lapses.' : 'Read the contract before doing anything else.',
      ]);
      return;
    }
    if (cfg.mode !== 'live') {
      r.wouldExecute.push({ didHash });
      return;
    }
    // A transaction still in flight has this nonce. Sending another could only race it.
    if (await reads.pendingTxs() > 0) {
      r.blocked.push({ didHash, reason: 'a transaction of ours is still pending' });
      s.blockedSince ??= nowSec;
      if (nowSec - s.blockedSince >= BLOCKED_ALERT_SECONDS) {
        await raise(s, nowSec, 'blocked', 'warn', 'The slash keeper is stuck behind a transaction of its own', [
          `agent ${didHash} is due, and the keeper has found itself blocked since ${new Date(s.blockedSince * 1000).toISOString()}.`,
          'It sends again once its pending transaction lands or is replaced. The other keeper may execute it meanwhile.',
        ]);
      }
      return;
    }
    try {
      const hash = await sender.send(didHash);
      s.executed[didHash] = hash;
      // Saved now, not at the end of the run: a run that fails after this would lose it, and the
      // slash would later be reported as settled by someone else.
      state.set(s);
      state.persist();
      r.executed.push({ didHash, hash });
      await notify('ok', 'The slash keeper executed a slash', [`agent ${didHash}`, `tx ${hash}`]);
    } catch (err) {
      const reason = said(err, cfg);
      r.failed.push({ didHash, reason });
      await raise(s, nowSec, `failed:${didHash}`, 'alert', 'The slash keeper did not confirm an execution', [`agent ${didHash}`, reason.slice(0, 300), 'It looks again every run, and the other keeper tries too.']);
    }
  }

  // A run that keeps failing is the one thing the loop has to report for itself.
  async function runFailed(err) {
    failedRuns += 1;
    if (failedRuns === FAILED_RUNS_ALERT) {
      await notify('alert', `The slash keeper has failed ${failedRuns} runs in a row`, [said(err, cfg).slice(0, 300)]);
    }
    return failedRuns;
  }

  return { runOnce, runFailed };
}

/**
 * The real sender: an EIP-1559 call to executeSlash, within the fee and gas limits, or nothing.
 *
 * The receipt is polled for rather than waited on with waitForTransaction, which counts a
 * confirmation only once it has seen a new block, so a slow one reported a slash that had settled
 * as failed. A failure after broadcast names the transaction: it may still land.
 */
function localSender({ wallet, staking, maxFeeWei, maxGas, waitMs = 120_000, pollMs = 2000 }) {
  const provider = wallet.provider;
  return {
    async send(didHash) {
      const fee = await provider.getFeeData();
      const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
      if (maxFeePerGas > maxFeeWei) throw new Error(`fee ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei is above KEEPER_MAX_FEE_GWEI ${ethers.formatUnits(maxFeeWei, 'gwei')}`);
      const tip = fee.maxPriorityFeePerGas ?? maxFeePerGas;
      const estimate = await staking.executeSlash.estimateGas(didHash);
      const gasLimit = estimate * 12n / 10n;
      if (gasLimit > maxGas) throw new Error(`gas ${gasLimit} is above KEEPER_MAX_GAS ${maxGas}`);
      const sent = await staking.connect(wallet).executeSlash(didHash, {
        gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas,
      });
      const giveUpAt = Date.now() + waitMs;
      for (;;) {
        // A receipt read that fails says nothing about the transaction, so it counts as not yet.
        const receipt = await provider.getTransactionReceipt(sent.hash).catch(() => null);
        if (receipt) {
          if (receipt.status !== 1) throw new Error(`executeSlash ${sent.hash} reverted`);
          return sent.hash;
        }
        if (Date.now() >= giveUpAt) throw new Error(`executeSlash ${sent.hash} was sent, with no receipt after ${Math.round(waitMs / 1000)} seconds. Check it before assuming it failed`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}

function readConfig(env = process.env) {
  const text = (name) => String(env[name] ?? '').trim();
  const need = (name) => {
    const v = text(name);
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const mode = text('KEEPER_MODE') || 'shadow';
  if (!['shadow', 'live'].includes(mode)) throw new Error(`KEEPER_MODE is "${mode}"; it is shadow or live`);
  const staking = need('STAKING_ADDRESS');
  if (!ethers.isAddress(staking)) throw new Error('STAKING_ADDRESS is not an address');

  // Said out loud in live mode, even when it is empty: the drill leaves a real slash to lapse, and
  // a keeper started without this list would burn that bond.
  const rawSkip = text('KEEPER_SKIP_AGENTS');
  if (mode === 'live' && !rawSkip) throw new Error('KEEPER_SKIP_AGENTS is required in live mode: list the didHashes to leave alone, or write none');
  const listed = rawSkip === 'none' ? [] : rawSkip.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const d of listed) if (!DID_HASH.test(d)) throw new Error(`KEEPER_SKIP_AGENTS has "${d}", which is not a didHash`);

  // Optional in shadow mode, where naming it only says which address to fund. The value is never
  // repeated in an error, and ethers is not given the chance to.
  const key = text('KEEPER_PRIVATE_KEY');
  if (mode === 'live' && !key) throw new Error('KEEPER_PRIVATE_KEY is required in live mode');
  if (key && !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('KEEPER_PRIVATE_KEY is not 32 bytes of hex');

  return {
    mode,
    name: text('KEEPER_NAME') || 'primary',
    rpcUrl: need('RPC_URL'),
    staking: ethers.getAddress(staking),
    fromBlock: Number(need('KEEPER_FROM_BLOCK')),
    graceSeconds: Number(text('KEEPER_GRACE_SECONDS') || 0),
    skip: new Set(listed),
    privateKey: key,
    chunkSize: Number(text('LOG_CHUNK_SIZE') || 2000),
    pollSeconds: Number(text('KEEPER_POLL_SECONDS') || 300),
    statePath: text('KEEPER_STATE_PATH') || '/data/keeper-state.json',
    minBalance: ethers.parseEther(text('KEEPER_MIN_BALANCE') || '0.2'),
    maxFeeWei: mode === 'live' ? ethers.parseUnits(need('KEEPER_MAX_FEE_GWEI'), 'gwei') : 0n,
    maxGas: BigInt(text('KEEPER_MAX_GAS') || 1_000_000),
    webhookUrl: text('WEBHOOK_URL'),
    webhookChatId: text('WEBHOOK_CHAT_ID'),
  };
}

/** Which of a contract's errors a simulated call reverted with, by name, or null if it passed. */
function revertName(err, iface) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try { return iface.parseError(data)?.name ?? data.slice(0, 10); } catch { return data.slice(0, 10); }
  }
  // A failed read says nothing about the slash, so it must not read as a refusal of it.
  throw err;
}

function webhookNotifier(cfg) {
  return async (level, title, lines) => {
    const text = [`[keeper ${cfg.name}] ${level.toUpperCase()}: ${title}`, ...lines.map((l) => `  ${l}`)].join('\n');
    (level === 'ok' ? console.log : console.error)(text);
    if (!cfg.webhookUrl) return;
    try {
      const payload = webhookPayload(cfg.webhookUrl, { level, title, lines, at: new Date().toISOString(), checker: `slash keeper, ${cfg.name}` }, cfg.webhookChatId);
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (!res.ok) console.error(`[keeper] webhook rejected the alert: ${res.status}`);
    } catch (err) {
      console.error(`[keeper] webhook delivery failed: ${said(err, cfg)}`);
    }
  };
}

function summary(r) {
  return `[keeper] run at block ${r.head}: ${r.open} open, ${r.waiting.length} waiting, ${r.held.length} held, ${r.lapsed.length} lapsed, ${r.disputed.length} disputed, `
    + `${r.refused.length} refused, ${r.wouldExecute.length} would execute, ${r.executed.length} executed, ${r.failed.length} failed, ${r.blocked.length} blocked`;
}

async function main() {
  let cfg;
  try { cfg = readConfig(); } catch (err) {
    console.error(`[keeper] ${err.message}`);
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const staking = new ethers.Contract(cfg.staking, STAKING_ABI, provider);
  const wallet = cfg.privateKey ? new ethers.Wallet(cfg.privateKey, provider) : null;
  // Each read through the backoff the oracle uses: a throttle says nothing about a slash. A real
  // revert carries its data and comes straight back, which is what simulate is asking for.
  const read = (label, fn) => readWithBackoff(`keeper ${label}`, fn);
  const executionPeriod = Number(await read('execution period', () => staking.EXECUTION_PERIOD()));
  const disputePeriod = Number(await read('dispute period', () => staking.DISPUTE_RESOLUTION_PERIOD()));
  const topic = staking.interface.getEvent('SlashInitiated').topicHash;
  const reads = {
    head: () => read('head', () => provider.getBlockNumber()),
    blockTime: async (block) => Number((await read('block', () => provider.getBlock(block))).timestamp),
    slashInitiated: async (from, to) => {
      const logs = await read('getLogs', () => provider.getLogs({ address: cfg.staking, topics: [topic], fromBlock: from, toBlock: to }));
      return logs.map((l) => l.topics[1]);
    },
    proposal: (didHash) => read('proposal', () => staking.getSlashProposal(didHash)),
    simulate: async (didHash) => {
      try {
        await read('simulate', () => staking.executeSlash.staticCall(didHash));
        return null;
      } catch (err) {
        return revertName(err, staking.interface);
      }
    },
    balance: () => read('balance', () => provider.getBalance(wallet.address)),
    pendingTxs: async () => {
      const [pending, latest] = await Promise.all([
        read('nonce', () => provider.getTransactionCount(wallet.address, 'pending')),
        read('nonce', () => provider.getTransactionCount(wallet.address, 'latest')),
      ]);
      return pending - latest;
    },
  };
  const store = fileState(cfg.statePath);
  const keeper = createKeeper({
    cfg: { ...cfg, executionPeriod, disputePeriod },
    reads,
    sender: cfg.mode === 'live' ? localSender({ wallet, staking, maxFeeWei: cfg.maxFeeWei, maxGas: cfg.maxGas }) : null,
    state: store,
    notify: webhookNotifier(cfg),
  });
  console.log(`[keeper] ${cfg.mode} mode, ${cfg.name}, as ${wallet ? wallet.address : 'no key'}, every ${cfg.pollSeconds}s, grace ${cfg.graceSeconds}s, leaving ${cfg.skip.size} agent(s) alone`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await keeper.runOnce();
      console.log(summary(r));
      for (const w of r.wouldExecute) console.log(`[keeper] shadow: would execute ${w.didHash}`);
      for (const h of r.held) console.log(`[keeper] held by KEEPER_SKIP_AGENTS: ${h.didHash}`);
    } catch (err) {
      const n = await keeper.runFailed(err);
      console.error(`[keeper] run failed (${n} in a row): ${said(err, cfg)}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, cfg.pollSeconds * 1000);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[keeper] could not start: ${redact(wordsOf(err), [process.env.RPC_URL, process.env.WEBHOOK_URL])}`);
    process.exit(1);
  });
}

module.exports = { decide, createKeeper, localSender, readConfig, revertName, summary, STAKING_ABI };
