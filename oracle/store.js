'use strict';

// Durable store for oracle attestation and flag state.
//
// The score factors driven by /attest and /flag (successScore, feeScore,
// communityScore) accumulate over time and cannot be recomputed from on-chain
// data — so unlike the rest of the epoch loop, they must survive a restart.
// State is small (one small object per agent), single-writer (only this
// process), and low-frequency (both endpoints are rate-limited), so a JSON
// file on a mounted volume is enough. Writes are atomic (temp + rename) so a
// crash mid-write cannot corrupt the file.

const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.ORACLE_STATE_PATH || '/data/oracle-state.json';

// Cooldown period for attestations: minimum time (ms) before the same attester
// can attest the same agent again. Prevents attestation spam/inflation.
const DEFAULT_ATTEST_COOLDOWN_MS = 3_600_000; // 1 hour
const ATTEST_COOLDOWN_MS = Number(process.env.ATTEST_COOLDOWN_MS) || DEFAULT_ATTEST_COOLDOWN_MS;

// didHash → { successful, total }
const attestations = new Map();
// didHash → unresolved flag count
const flags = new Map();

// didHash → ERC-8004 agentId (string) this agent is linked to (ownership-verified at link time)
const links = new Map();
// "attester:didHash" → timestamp (ms) of last attestation — dedupe/cooldown guard
const attestCooldowns = new Map();
// didHash → [{ txHash, ts, amount: string, payer, success }] — one per verified payment.
//
// Individual events rather than a running total, because a total cannot be decayed:
// weighting a payment by its age needs to know when it happened. Amounts are strings
// because JSON has no BigInt and an 18-decimal token overflows a JSON number. The
// payer is kept for the same reason the timestamp is, so that counting distinct
// counterparties later is a scoring change and not a storage migration.
const paymentEvents = new Map();
// Settlement tx hashes already credited, so a receipt cannot be presented twice.
const usedPaymentTxs = new Set();
// Where the AgentRegistered log scan got to, and what it found. Persisted so a
// restart resumes instead of replaying the chain from FROM_BLOCK, which grows with
// every block and eventually trips a public RPC's rate limit.
let scanState = null;

/**
 * Clear `count` flags from an agent, and report what actually changed.
 *
 * Flagging was one-way: /flag incremented and nothing anywhere decremented, so a flag
 * was permanent short of hand-editing the state file on the host. That is a problem as
 * soon as anything automated produces flags, because a threshold that misfires costs an
 * agent two Community points per flag with no way back. Community is only worth five
 * points, so three bad flags take it to zero and pin it there.
 *
 * Clamped rather than validated: resolving more flags than exist leaves zero, and the
 * result says how many were really removed. The caller learns the truth without having
 * to read the count first and race whoever else is writing.
 *
 * The entry is deleted at zero rather than left as 0, so the state file does not grow a
 * permanent record of every agent ever flagged.
 */
function resolveFlags(didHash, count = 1) {
  const before = flags.get(didHash) ?? 0;
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) return { before, after: before, resolved: 0 };

  const after = Math.max(0, before - n);
  if (after === 0) flags.delete(didHash);
  else flags.set(didHash, after);
  return { before, after, resolved: before - after };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(parsed.attestations || {})) attestations.set(k, v);
    for (const [k, v] of Object.entries(parsed.flags || {})) flags.set(k, v);
    for (const [k, v] of Object.entries(parsed.links || {})) links.set(k, v);
    for (const [k, v] of Object.entries(parsed.attestCooldowns || {})) attestCooldowns.set(k, v);
    for (const [k, v] of Object.entries(parsed.paymentEvents || {})) paymentEvents.set(k, v);
    for (const h of parsed.usedPaymentTxs || []) usedPaymentTxs.add(h);
    scanState = parsed.scanState || null;
    console.log(`[oracle] state loaded from ${STATE_PATH}: ${attestations.size} attestations, ${flags.size} flags, ${links.size} links, ${attestCooldowns.size} cooldowns`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[oracle] no prior state at ${STATE_PATH}, starting fresh`);
    } else {
      console.warn(`[oracle] state load failed (${err.message}); starting fresh`);
    }
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      attestations: Object.fromEntries(attestations),
      flags: Object.fromEntries(flags),
      links: Object.fromEntries(links),
      attestCooldowns: Object.fromEntries(attestCooldowns),
      paymentEvents: Object.fromEntries(paymentEvents),
      usedPaymentTxs: [...usedPaymentTxs],
      scanState,
      savedAt: new Date().toISOString(),
    }));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.error(`[oracle] state persist FAILED: ${err.message}`);
  }
}

function attestCooldownKey(attester, didHash) {
  return `${attester}:${didHash}`;
}

function checkAttestCooldown(attester, didHash, now = Date.now()) {
  const key = attestCooldownKey(attester, didHash);
  const lastAttest = attestCooldowns.get(key);
  if (!lastAttest) return { allowed: true, remainingMs: 0 };
  const elapsed = now - lastAttest;
  if (elapsed >= ATTEST_COOLDOWN_MS) return { allowed: true, remainingMs: 0 };
  return { allowed: false, remainingMs: ATTEST_COOLDOWN_MS - elapsed };
}

function recordAttestation(attester, didHash, now = Date.now()) {
  const key = attestCooldownKey(attester, didHash);
  attestCooldowns.set(key, now);
}

function pruneExpiredCooldowns(now = Date.now()) {
  for (const [key, ts] of attestCooldowns.entries()) {
    if (now - ts >= ATTEST_COOLDOWN_MS) attestCooldowns.delete(key);
  }
}

/// Records a verified payment against an agent. Returns false when this settlement
/// has already been credited, which is the replay guard: the same receipt presented
/// twice must not count twice.
function creditPayment(didHash, txHash, amount, payer, success, now = Date.now()) {
  const key = txHash.toLowerCase();
  if (usedPaymentTxs.has(key)) return false;
  usedPaymentTxs.add(key);
  const list = paymentEvents.get(didHash) ?? [];
  // The settlement hash is kept, not just used for dedupe: it is what lets a third
  // party pull the payment off the chain and check it for themselves, which is the
  // whole point of committing to the evidence.
  list.push({ txHash: key, ts: now, amount: BigInt(amount).toString(), payer, success: !!success });
  paymentEvents.set(didHash, list);
  return true;
}

function getPaymentEvents(didHash) {
  return paymentEvents.get(didHash) ?? [];
}

/// Undecayed lifetime volume. Reported, not scored: scoring uses the decayed sum.
function paymentVolume(didHash) {
  return getPaymentEvents(didHash).reduce((sum, e) => sum + BigInt(e.amount), 0n);
}

/// Drops events whose decayed weight has fallen below `minWeight`, so the log does
/// not grow without bound. At a 90-day half-life and the default floor this keeps
/// roughly the last three years, by which point an event contributes under a
/// thousandth of its original value and cannot move an integer score.
function prunePaymentEvents(halfLifeMs, minWeight = 0.001, now = Date.now()) {
  if (!halfLifeMs || halfLifeMs <= 0) return 0;
  const cutoff = now - halfLifeMs * (Math.log2(1 / minWeight));
  let dropped = 0;
  for (const [did, list] of paymentEvents.entries()) {
    const kept = list.filter(e => e.ts >= cutoff);
    dropped += list.length - kept.length;
    if (kept.length === 0) paymentEvents.delete(did);
    else if (kept.length !== list.length) paymentEvents.set(did, kept);
  }
  return dropped;
}

function getScanState() { return scanState; }
function setScanState(state) { scanState = state; }

function isStatePathWritable() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const testPath = `${STATE_PATH}.writable-test`;
    fs.writeFileSync(testPath, 'ok');
    fs.unlinkSync(testPath);
    return true;
  } catch {
    return false;
  }
}

function getStatePath() {
  return STATE_PATH;
}

module.exports = {
  attestations,
  flags,
  resolveFlags,
  links,
  attestCooldowns,
  paymentEvents,
  usedPaymentTxs,
  creditPayment,
  getScanState,
  setScanState,
  getPaymentEvents,
  paymentVolume,
  prunePaymentEvents,
  load,
  persist,
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
  ATTEST_COOLDOWN_MS,
};
