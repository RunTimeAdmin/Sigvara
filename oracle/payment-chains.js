'use strict';

/**
 * Payment evidence from chains other than the one scored: ADR 0009.
 *
 * Identities, bonds, proposals and scores stay on the scored chain (Arc). A payment chain is
 * one this oracle only reads payments from, by the same pull scan ADR 0003 runs on the scored
 * chain, so a payment an agent receives on Base enters its score without anybody reporting it.
 * Base Sepolia is the first, on testnet only (David, 3 November 2026).
 *
 * What differs from the scored chain, and is here rather than spread through the scan:
 *
 *   - Finality. The scored chain's floor of 6 blocks is 1.2 seconds on Base Sepolia. A payment
 *     chain is scanned up to its `finalized` block instead.
 *   - Whose address it is. An address derived from a key is the same account on every chain; a
 *     contract is not, so a payment to an agent registered at a contract is skipped as
 *     `contract_recipient` (see recipientCodeOk).
 *   - Registration. A payment made before the agent registered is skipped as
 *     `before_registration`, as on the scored chain, though by the block's time and not its number,
 *     since a payment chain's blocks are not the scored chain's. Otherwise whether it counted would
 *     depend on whether an operator happened to scan its block before or after the registration.
 *   - Units. Each chain names its own asset and fee unit, and amounts are converted into the
 *     scored chain's fee units before evidence from different chains is added up (forScoring).
 *   - Timing. A payment chain's evidence enters a score only once it is older than the chain's
 *     delay (eventsAt), and an operator whose scan has not reached that far scores nothing
 *     (behind). Two operators then hold the same evidence for any proposal time, which a
 *     finality lag of a quarter of an hour would otherwise make them disagree about.
 *   - One cut-off. With payment chains configured, a score's evidence is everything that counted by
 *     a whole-minute cut-off just before the scoring operator's clock (cutFor), on both chains, so
 *     what it holds beyond that cannot change it. The scored chain's payments keep their stored
 *     order and a payment chain's follow in a fixed one (eventsAt), because two operators credit the
 *     two chains at different times and the evidence root depends on the order of its leaves. A
 *     checker tries the whole-minute cut-offs in the half hour before a proposal (auditCuts).
 *
 * With PAYMENT_CHAIN_IDS unset nothing here runs and the oracle behaves as it did before.
 */

const net = require('net');
const { ethers } = require('ethers');
const paymentScan = require('./payment-scan');

const DEFAULT_DELAY_SECONDS = 3600;
// Longer than Base Sepolia's finality lag (about 17 minutes, measured 3 November 2026) with room to
// spare. A delay shorter than the lag holds every epoch, since the scan can never reach that far.
const MIN_DELAY_SECONDS = 1800;
// Base Sepolia's public endpoint refuses eth_getLogs over more than 200 blocks (measured
// 3 November 2026). A provider that allows more can be given more.
const DEFAULT_CHUNK = 200;
const DEFAULT_PACE_MS = 500;
// Blocks one scan covers at most: two hours of Base Sepolia, twenty of Base. A catch-up then
// advances a bounded step per epoch instead of retrying an ever larger range after one failed call.
const DEFAULT_MAX_BLOCKS = 36_000;
const MODES = ['shadow', 'on'];
// A score's evidence is cut at a whole minute, one minute before the scoring operator's clock, so a
// checker can find the cut from the proposal's time alone. It tries every whole minute in the half
// hour before the proposal, which is how late a proposal may land after its operator chose its
// evidence, and so also how far a primary can lag its evidence and still be believed.
const CUT_QUANTUM_MS = 60_000;
const AUDIT_WINDOW_MS = 30 * 60_000;

// An EIP-7702 delegation designator: 0xef0100 followed by the delegate's address. The account
// is still the key's.
const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

function configError(message) {
  return new Error(`PAYMENT_CHAIN: ${message}`);
}

function wholeNumber(raw, name, { min = 0, fallback = undefined } = {}) {
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw configError(`${name} is required`);
  }
  if (!/^\d+$/.test(String(raw).trim())) throw configError(`${name} must be a whole number`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw configError(`${name} must be at least ${min}`);
  return n;
}

function bigUnits(raw, name, { min = 0n, fallback = undefined } = {}) {
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw configError(`${name} is required`);
  }
  if (!/^\d+$/.test(String(raw).trim())) throw configError(`${name} must be a whole number of base units`);
  const n = BigInt(String(raw).trim());
  if (n < min) throw configError(`${name} must be at least ${min}`);
  return n;
}

/**
 * https, or http only to this host or a private network (a node beside the oracle, a Docker service
 * name): the URL usually carries a provider's key, which plain http would send in the clear.
 */
function rpcUrlProblem(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'must be a URL'; }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'must be https (http only to a private host)';
  const h = url.hostname.toLowerCase();
  // Address ranges only for an address: 10.attacker.example is a public name.
  const privateAddress = net.isIP(h) === 4
    && (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
  const privateHost = ['localhost', '[::1]'].includes(h) || (!h.includes('.') && !h.includes(':')) || privateAddress;
  return privateHost ? null : 'must be https (http only to a private host)';
}

/**
 * The payment chains this oracle reads, from the environment.
 *
 *   PAYMENT_CHAIN_IDS=84532
 *   PAYMENT_CHAIN_84532_RPC_URL=...        required, never echoed
 *   PAYMENT_CHAIN_84532_ASSET=0x...        required: the ERC-20 payments settle in
 *   PAYMENT_CHAIN_84532_FROM_BLOCK=...     required: both operators start from the same block
 *   PAYMENT_CHAIN_84532_FEE_UNIT=...       required: base units of this asset per point
 *   PAYMENT_CHAIN_84532_MODE=shadow|on     default shadow: scan and report, credit nothing
 *   PAYMENT_CHAIN_84532_DELAY_SECONDS=3600 how old a payment must be before it is scored
 *   PAYMENT_CHAIN_84532_MIN_AMOUNT=0, _CHUNK=200, _PACE_MS=500, _MAX_BLOCKS=36000
 *
 * Throws on anything it cannot use, without the RPC URL in the message.
 *
 * @param {object} env
 * @param {{ scoredChainId?: number|null, paymentRequired?: boolean }} context
 */
function readConfig(env = process.env, { scoredChainId = null, paymentRequired = true } = {}) {
  const list = String(env.PAYMENT_CHAIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const chains = [];
  const byId = new Map();
  for (const raw of list) {
    const chainId = wholeNumber(raw, 'PAYMENT_CHAIN_IDS entry', { min: 1 });
    if (byId.has(chainId)) throw configError(`chain ${chainId} is listed twice`);
    if (scoredChainId != null && chainId === Number(scoredChainId)) {
      throw configError(`chain ${chainId} is the scored chain; its payments are read by the payment scan already`);
    }
    const p = `PAYMENT_CHAIN_${chainId}_`;
    const rpcUrl = String(env[`${p}RPC_URL`] || '').trim();
    if (!rpcUrl) throw configError(`${p}RPC_URL is required`);
    const urlProblem = rpcUrlProblem(rpcUrl);
    if (urlProblem) throw configError(`${p}RPC_URL ${urlProblem}`);
    const assetRaw = String(env[`${p}ASSET`] || '').trim();
    if (!ethers.isAddress(assetRaw)) throw configError(`${p}ASSET must be an address`);
    const mode = String(env[`${p}MODE`] || 'shadow').trim().toLowerCase();
    if (!MODES.includes(mode)) throw configError(`${p}MODE must be "shadow" or "on"`);
    const chain = Object.freeze({
      chainId,
      rpcUrl,
      asset: ethers.getAddress(assetRaw),
      fromBlock: wholeNumber(env[`${p}FROM_BLOCK`], `${p}FROM_BLOCK`),
      feeUnit: bigUnits(env[`${p}FEE_UNIT`], `${p}FEE_UNIT`, { min: 1n }),
      minAmount: bigUnits(env[`${p}MIN_AMOUNT`], `${p}MIN_AMOUNT`, { fallback: 0n }),
      delayMs: wholeNumber(env[`${p}DELAY_SECONDS`], `${p}DELAY_SECONDS`, {
        min: MIN_DELAY_SECONDS, fallback: DEFAULT_DELAY_SECONDS,
      }) * 1000,
      chunkSize: wholeNumber(env[`${p}CHUNK`], `${p}CHUNK`, { min: 1, fallback: DEFAULT_CHUNK }),
      paceMs: wholeNumber(env[`${p}PACE_MS`], `${p}PACE_MS`, { fallback: DEFAULT_PACE_MS }),
      maxBlocks: wholeNumber(env[`${p}MAX_BLOCKS`], `${p}MAX_BLOCKS`, { min: 1, fallback: DEFAULT_MAX_BLOCKS }),
      mode,
    });
    chains.push(chain);
    byId.set(chainId, chain);
  }
  // Payments are only scored with verification on, so a payment chain without it would scan and
  // change nothing, which looks like a chain where nobody was paid.
  if (chains.length && !paymentRequired) {
    throw configError('PAYMENT_CHAIN_IDS needs PAYMENT_VERIFICATION=required');
  }
  return Object.freeze({ chains: Object.freeze(chains), byId });
}

/** The state key for a chain's scan. A shadow scan keeps its own cursor, so turning a chain on starts at FROM_BLOCK. */
function stateKey(chain) {
  return chain.mode === 'on' ? String(chain.chainId) : `${chain.chainId}/shadow`;
}

/** Whether code at an address leaves it the key's account: none, or only an EIP-7702 delegation. */
function recipientCodeOk(code) {
  const c = String(code || '').toLowerCase();
  return c === '0x' || c === '' || DELEGATION.test(c);
}

/**
 * When a payment starts to count, in milliseconds: its settlement on the scored chain, its
 * settlement plus the chain's delay on a payment chain, and never for a chain not switched on.
 */
function eligibleAtMs(event, cfg) {
  if (event.chainId == null) return Number(event.ts);
  const chain = cfg.byId.get(Number(event.chainId));
  return chain && chain.mode === 'on' ? Number(event.ts) + chain.delayMs : Infinity;
}

const lower = (x) => String(x ?? '').toLowerCase();

/**
 * Whether any payment chain is switched on. Only then do a payment chain's payments count, and only
 * then does evidence follow the cut-off rule below: a chain in shadow changes nothing about scoring.
 */
function active(cfg) {
  return cfg.chains.some((c) => c.mode === 'on');
}

/** The cut-off for a score made at `nowMs`: a whole minute, one before. `nowMs` itself when no chain is on. */
function cutFor(nowMs, cfg) {
  if (!active(cfg)) return nowMs;
  return Math.floor(nowMs / CUT_QUANTUM_MS) * CUT_QUANTUM_MS - CUT_QUANTUM_MS;
}

/**
 * The cut-off this operator can stand behind: `wantMs` (from cutFor), brought down to a whole minute
 * before each scan's reach, so that it holds every payment that counted by it, on every chain. The
 * scored chain's scan must have passed it, and each payment chain's scan must have passed it less
 * that chain's delay, strictly, since blocks share whole-second timestamps. Null when a chain that is
 * on has never been scanned.
 *
 * @param {number} scoredReachMs the scored chain's scan's last block time, in ms
 * @param {(key: string) => ({ lastBlockTs: number }|null)} stateOf
 */
function coveredCut(wantMs, scoredReachMs, cfg, stateOf) {
  let cap = Math.min(wantMs, scoredReachMs - 1);
  for (const chain of cfg.chains) {
    if (chain.mode !== 'on') continue;
    const state = stateOf(stateKey(chain));
    if (!state || !Number.isFinite(state.lastBlockTs)) return null;
    cap = Math.min(cap, state.lastBlockTs * 1000 + chain.delayMs - 1);
  }
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return Math.floor(cap / CUT_QUANTUM_MS) * CUT_QUANTUM_MS;
}

/** The cut-offs a checker tries for a proposal dated `atMs`, newest first: every whole minute in the half hour before. */
function auditCuts(atMs, cfg) {
  if (!active(cfg)) return [];
  const out = [];
  for (let t = Math.floor(atMs / CUT_QUANTUM_MS) * CUT_QUANTUM_MS; t > atMs - AUDIT_WINDOW_MS; t -= CUT_QUANTUM_MS) out.push(t);
  return out;
}

/**
 * The fixed order of a payment chain's payments in an agent's evidence: by settlement time, then
 * chain, transaction and payer, which together identify a credit.
 */
function evidenceOrder(a, b) {
  return (Number(a.ts) - Number(b.ts))
    || ((a.chainId ?? 0) - (b.chainId ?? 0))
    || (lower(a.txHash) < lower(b.txHash) ? -1 : lower(a.txHash) > lower(b.txHash) ? 1 : 0)
    || (lower(a.payer) < lower(b.payer) ? -1 : lower(a.payer) > lower(b.payer) ? 1 : 0);
}

// The last answer for each stored array, per config. For one array the set that counts only grows
// with the cut-off, so an answer of the same size is the same answer, and handing back the same
// frozen array lets the evidence cache and the Merkle root cache hit.
const memo = new WeakMap();

/**
 * The evidence that counts by the cut-off `atMs`, in milliseconds, in the order the root is built over.
 *
 * With no payment chain on: every stored payment of the scored chain, the very same array when that
 * is all it holds, as before; payments from a chain removed or put back in shadow do not count. With one on: the
 * scored chain's payments settled by `atMs`, in the order they are stored, then the payment chains'
 * payments at least their delay old by `atMs`, in a fixed order (evidenceOrder). Nothing from a chain
 * this oracle no longer reads, or reads in shadow: there is no fee unit to convert it with, and an
 * operator that dropped a chain must not keep scoring from it. What counts depends only on the
 * cut-off, never on what an operator happens to hold beyond it.
 */
function eventsAt(events, atMs, cfg) {
  if (!active(cfg)) {
    return events.some((e) => e.chainId != null) ? Object.freeze(events.filter((e) => e.chainId == null)) : events;
  }
  const scored = [];
  const fromChains = [];
  for (const e of events) {
    if (e.chainId == null) {
      if (Number(e.ts) <= atMs) scored.push(e);
    } else if (eligibleAtMs(e, cfg) <= atMs) {
      fromChains.push(e);
    }
  }
  if (!fromChains.length && scored.length === events.length) return events;
  const size = scored.length + fromChains.length;
  let byArray = memo.get(cfg);
  if (!byArray) { byArray = new WeakMap(); memo.set(cfg, byArray); }
  const hit = Object.isFrozen(events) ? byArray.get(events) : undefined;
  if (hit && hit.length === size) return hit;
  const result = Object.freeze([...scored, ...fromChains.sort(evidenceOrder)]);
  if (Object.isFrozen(events)) byArray.set(events, result);
  return result;
}

/**
 * The events as the score reads them: a payment chain's amounts converted into the scored chain's
 * fee units. The stored amount is the chain's own, because the evidence leaf commits to what a
 * verifier reads off that chain; only the arithmetic sees the converted one.
 */
function forScoring(events, scoredFeeUnit, cfg) {
  if (!events.some((e) => e.chainId != null)) return events;
  const unit = BigInt(scoredFeeUnit);
  return events.map((e) => {
    if (e.chainId == null) return e;
    const chain = cfg.byId.get(Number(e.chainId));
    if (!chain) return { ...e, amount: '0' };
    return { ...e, amount: ((BigInt(e.amount) * unit) / chain.feeUnit).toString() };
  });
}

/**
 * The chains switched on whose scan has not passed `nowMs` less their delay. While any has not, this
 * operator may be missing evidence the other operator holds, so it scores nothing (ADR 0009,
 * decision 3). A chain never scanned is behind.
 *
 * Reaching that second exactly is not enough: blocks share whole-second timestamps (five a second
 * on Base Sepolia), so the next block may carry the same time and already count.
 *
 * @param {(key: string) => ({ lastBlock: number, lastBlockTs: number }|null)} stateOf
 */
function behind(cfg, stateOf, nowMs) {
  const out = [];
  for (const chain of cfg.chains) {
    if (chain.mode !== 'on') continue;
    const state = stateOf(stateKey(chain));
    const reachedMs = state && Number.isFinite(state.lastBlockTs) ? state.lastBlockTs * 1000 : null;
    if (reachedMs === null || reachedMs <= nowMs - chain.delayMs) {
      out.push({ chainId: chain.chainId, reachedMs, neededMs: nowMs - chain.delayMs });
    }
  }
  return out;
}

/** What /health says about each chain, including what both operators must share. Never the RPC URL. */
function publicView(cfg, stateOf, lastScans) {
  return cfg.chains.map((chain) => {
    const state = stateOf(stateKey(chain)) || {};
    const last = lastScans.get(chain.chainId) || null;
    return {
      chainId: chain.chainId,
      mode: chain.mode,
      asset: chain.asset,
      fromBlock: chain.fromBlock,
      feeUnit: chain.feeUnit.toString(),
      minAmount: chain.minAmount.toString(),
      delaySeconds: chain.delayMs / 1000,
      lastBlock: state.lastBlock ?? null,
      lastBlockTs: state.lastBlockTs ?? null,
      lastScan: last,
    };
  });
}

/**
 * One scan of one payment chain. Everything it touches is passed in, so it can be tested without
 * the oracle around it.
 *
 * @param {object} chain one of readConfig().chains
 * @param {object} deps
 *   @param {object} deps.provider        the payment chain's: send, getBlock, getLogs, getCode
 *   @param {object} deps.scoredProvider  the scored chain's, for the recipient's code there
 *   @param {Array<{didHash, agentAddress, operator}>} deps.agents
 *   @param {object|null} deps.state      the last { lastBlock, lastBlockTs } for this chain
 *   @param {(txHash, didHash, payer) => boolean} deps.isCredited  already credited on THIS chain
 *   @param {(credit, tsMs) => boolean} deps.credit  credit one payment; not called in shadow mode
 *   @param {(didHash) => Promise<number>} deps.registeredAtMs  when the agent registered, in ms
 *   @param {Map<string, object[]>} deps.knownOnChain  this chain's payments already held, for the canary
 *   @param {(label, fn) => Promise} deps.read  backoff for one RPC read; its errors must not carry the URL
 *   @param {(ms) => Promise} [deps.sleep]
 * @returns {Promise<object>} a summary; `state` is what to store, or null to leave it as it was
 */
async function scanChain(chain, deps) {
  const { provider, scoredProvider, agents, state, isCredited, credit, registeredAtMs, knownOnChain, read } = deps;

  const actual = Number(BigInt(await read('payment chain id', () => provider.send('eth_chainId', []))));
  if (actual !== chain.chainId) {
    throw new Error(`the RPC for payment chain ${chain.chainId} serves chain ${actual}`);
  }
  const finalized = await read('payment chain finalized block', () => provider.getBlock('finalized'));
  if (!finalized || !Number.isInteger(finalized.number)) {
    throw new Error(`payment chain ${chain.chainId} did not return a finalized block`);
  }
  const from = state && Number.isInteger(state.lastBlock) ? state.lastBlock + 1 : chain.fromBlock;
  if (from > finalized.number) {
    return { from, to: finalized.number, credited: 0, skipped: 0, upToDate: true, state: null, reasons: {} };
  }
  // At most maxBlocks a scan, so a long catch-up moves forward a step at a time.
  const to = Math.min(finalized.number, from + chain.maxBlocks - 1);
  let toTs = Number(finalized.timestamp);
  if (to !== finalized.number) {
    const block = await read('payment chain getBlock', () => provider.getBlock(to));
    if (!block) throw new Error(`payment chain ${chain.chainId} did not return block ${to}`);
    toTs = Number(block.timestamp);
  }

  const byAddress = new Map();
  const byDid = new Map();
  for (const a of agents) {
    if (a.agentAddress) byAddress.set(a.agentAddress.toLowerCase(), a);
    byDid.set(a.didHash, a);
  }

  const logs = await paymentScan.scanRange(
    {
      readLogs: (filter) => read('payment chain getLogs', () => provider.getLogs(filter)),
      asset: chain.asset,
      paceMs: chain.paceMs,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
    [...byAddress.values()].map((a) => a.agentAddress),
    from, to, chain.chunkSize,
  );

  const plan = paymentScan.planCredits(logs.map((log) => paymentScan.decodeTransfer(log, chain.asset)), {
    didHashOf: (address) => byAddress.get(address.toLowerCase())?.didHash ?? null,
    operatorOf: (didHash) => byDid.get(didHash)?.operator ?? null,
    isUsed: isCredited,
    minAmount: chain.minAmount,
  });
  const skipped = [...plan.skipped];
  const skip = (c, reason) => skipped.push({ txHash: c.txHash, didHash: c.didHash, payer: c.payer, amount: c.amount, reason });

  // The recipient's code on both chains. Read for each recipient that has a payment, not for every
  // agent, and at the scanned block on the payment chain so that two operators ask the same question.
  const codeOk = new Map();
  for (const address of new Set(plan.credits.map((c) => byDid.get(c.didHash)?.agentAddress))) {
    if (!address) continue;
    const [here, scored] = await Promise.all([
      read('payment chain getCode', () => provider.getCode(address, to)),
      read('scored chain getCode', () => scoredProvider.getCode(address)),
    ]);
    codeOk.set(address.toLowerCase(), recipientCodeOk(here) && recipientCodeOk(scored));
  }
  const kept = [];
  for (const c of plan.credits) {
    const address = String(byDid.get(c.didHash)?.agentAddress || '').toLowerCase();
    if (codeOk.get(address) === false) skip(c, 'contract_recipient');
    else kept.push(c);
  }

  // The block's own time, as on the scored chain: crediting with the clock would make an old
  // payment look fresh and defeat the decay.
  const times = new Map();
  for (const n of new Set(kept.map((c) => c.blockNumber))) {
    const block = await read('payment chain getBlock', () => provider.getBlock(n));
    if (block) times.set(n, Number(block.timestamp) * 1000);
  }
  const registered = new Map();
  for (const did of new Set(kept.map((c) => c.didHash))) registered.set(did, await registeredAtMs(did));

  let credited = 0;
  let refused = 0;
  const unresolved = [];
  for (const c of kept) {
    const ts = times.get(c.blockNumber);
    if (ts === undefined) { unresolved.push(c); continue; }
    const since = registered.get(c.didHash);
    if (!Number.isFinite(since) || ts < since) { skip(c, 'before_registration'); continue; }
    if (chain.mode !== 'on') { credited += 1; continue; }
    if (credit(c, ts)) credited += 1;
    else refused += 1;
  }

  // As on the scored chain: an empty scan is believed only once the same filter finds a payment
  // already held on this chain. In shadow mode none is held, so the verdict is 'unavailable'.
  let canary = 'not_run';
  if (credited === 0) canary = await chainCanary(chain, provider, knownOnChain, byDid, read);

  const checkpoint = paymentScan.checkpointAfter(unresolved, from, to, canary);
  let next = null;
  if (checkpoint !== null) {
    let checkpointTs = toTs;
    if (checkpoint !== to) {
      const block = await read('payment chain getBlock', () => provider.getBlock(checkpoint));
      checkpointTs = block ? Number(block.timestamp) : null;
    }
    if (checkpointTs !== null) next = { lastBlock: checkpoint, lastBlockTs: checkpointTs, at: Date.now() };
  }

  const reasons = {};
  for (const sk of skipped) reasons[sk.reason] = (reasons[sk.reason] || 0) + 1;
  return {
    from, to, credited, refused, skipped: skipped.length, unresolved: unresolved.length,
    canary, reasons, state: next, caughtUp: to === finalized.number,
  };
}

async function chainCanary(chain, provider, knownOnChain, byDid, read) {
  const canary = paymentScan.pickCanary(knownOnChain, (did) => byDid.get(did)?.agentAddress ?? null);
  if (!canary || !Number.isInteger(canary.blockNumber)) return 'unavailable';
  try {
    const logs = await read('payment chain canary', () => provider.getLogs(
      paymentScan.canaryFilter(chain.asset, canary.recipient, canary.blockNumber),
    ));
    return paymentScan.canaryVerdict(logs, canary.txHash);
  } catch (err) {
    console.warn(`[oracle] payment chain ${chain.chainId} canary could not run: ${err.message}`);
    return 'unavailable';
  }
}

/**
 * An RPC error fit to log: its code and short message, never the endpoint. ethers puts the whole
 * request URL, with a provider's key in it, into `message`, and a server can echo it in its body.
 */
function rpcError(err, url) {
  const short = String(err?.shortMessage || String(err?.message ?? err).split(' (')[0]);
  // The JSON-RPC error's numeric code, which says what went wrong (a range limit, say) without its
  // text, which a node can fill with the request.
  const rpcCode = Number.isInteger(err?.error?.code) ? ` (rpc ${err.error.code})` : '';
  const out = new Error(`${short.split(url).join('<rpc>').slice(0, 200)}${rpcCode}`);
  if (err && err.code !== undefined) out.code = err.code;
  return out;
}

module.exports = {
  DEFAULT_DELAY_SECONDS,
  MIN_DELAY_SECONDS,
  DEFAULT_CHUNK,
  DEFAULT_MAX_BLOCKS,
  CUT_QUANTUM_MS,
  AUDIT_WINDOW_MS,
  readConfig,
  active,
  cutFor,
  coveredCut,
  auditCuts,
  stateKey,
  recipientCodeOk,
  eligibleAtMs,
  evidenceOrder,
  eventsAt,
  forScoring,
  behind,
  publicView,
  scanChain,
  rpcError,
};
