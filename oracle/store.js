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
// The decay curve lives in payments.js. Imported rather than reimplemented so flags and
// payments age on exactly the same function; payments.js requires only ethers, so this
// direction of dependency is not circular.
const { decayWeight, WEIGHT_SCALE } = require('./payments');

const STATE_PATH = process.env.ORACLE_STATE_PATH || '/data/oracle-state.json';

// Cooldown period for attestations: minimum time (ms) before the same attester
// can attest the same agent again. Prevents attestation spam/inflation.
const DEFAULT_ATTEST_COOLDOWN_MS = 3_600_000; // 1 hour
const ATTEST_COOLDOWN_MS = Number(process.env.ATTEST_COOLDOWN_MS) || DEFAULT_ATTEST_COOLDOWN_MS;

// didHash → { successful, total }
const attestations = new Map();
// didHash → array of flag timestamps (ms), oldest first.
//
// A bare count until 19 Sep 2026, which made flags the one signal in the model that
// never decayed: a flag raised a year ago weighed exactly as much as one raised this
// morning. Everything else decays on purpose, so that manufactured evidence evaporates
// unless renewed, and the same argument runs in reverse for a penalty — an agent that
// has behaved for months should not still be paying for a single old flag. Storing the
// times is what makes that possible; a count cannot be aged.
const flags = new Map();

// Shorter than the 90-day payment half-life by default. A flag is an accusation
// nobody has had to substantiate, so it should fade faster than evidence that was
// verified against the chain.
const DEFAULT_FLAG_HALF_LIFE_DAYS = 30;
const FLAG_HALF_LIFE_MS =
  Number(process.env.FLAG_HALF_LIFE_DAYS ?? DEFAULT_FLAG_HALF_LIFE_DAYS) * 86_400_000;

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
  const list = flags.get(didHash) ?? [];
  const before = list.length;
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) return { before, after: before, resolved: 0 };

  // Newest first. The case this exists for is an automated producer misfiring, and the
  // flags it just raised are the ones at the end. Removing the oldest would leave the
  // mistake in place and clear whatever legitimate flag preceded it.
  const after = Math.max(0, before - n);
  if (after === 0) flags.delete(didHash);
  else flags.set(didHash, list.slice(0, after));
  return { before, after, resolved: before - after };
}

/// Raise a flag. Returns the new raw count, which is what the endpoint reports: an
/// operator asking "did that land" wants to see their flag, not a decayed weight that
/// starts at 1 and immediately begins falling.
function addFlag(didHash, now = Date.now()) {
  const list = flags.get(didHash) ?? [];
  list.push(now);
  flags.set(didHash, list);
  return list.length;
}

/// Raw, undecayed count. For display and for the resolve endpoint's arithmetic.
function flagCount(didHash) {
  return (flags.get(didHash) ?? []).length;
}

/**
 * Age-weighted flag count, which is what the score should use.
 *
 * Reuses payments.decayWeight so there is exactly one decay curve in the codebase; a
 * second implementation here would drift from it the first time either was tuned. That
 * function returns a BigInt scaled by WEIGHT_SCALE because token amounts need the
 * precision — flags are small integers, so the float conversion is safe and is the same
 * idiom payments.js already uses for its recency figure.
 *
 * Fractional by design. communityScore is max(0, 5 - flags*2) floored, so a flag decays
 * out of the penalty in steps rather than vanishing at an arbitrary cutoff.
 */
function decayedFlagCount(didHash, now = Date.now(), halfLifeMs = FLAG_HALF_LIFE_MS) {
  const list = flags.get(didHash);
  if (!list || list.length === 0) return 0;
  let sum = 0;
  for (const ts of list) {
    sum += Number(decayWeight(now - ts, halfLifeMs)) / Number(WEIGHT_SCALE);
  }
  return sum;
}

/// Drops flags whose weight has fallen far enough that they can no longer move the
/// integer score, so the array does not grow forever. At a 30-day half-life the default
/// floor keeps roughly the last ten months; below it, two hundred such flags together
/// would not cost a single point.
function pruneFlags(minWeight = 0.001, now = Date.now(), halfLifeMs = FLAG_HALF_LIFE_MS) {
  for (const [didHash, list] of flags.entries()) {
    const kept = list.filter(
      ts => Number(decayWeight(now - ts, halfLifeMs)) / Number(WEIGHT_SCALE) >= minWeight
    );
    if (kept.length === 0) flags.delete(didHash);
    else if (kept.length !== list.length) flags.set(didHash, kept);
  }
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(parsed.attestations || {})) attestations.set(k, v);
    /* Flags were a bare count before 19 Sep 2026 and are timestamps now.
     *
     * A legacy file has no record of when each flag was raised, so the best available
     * estimate is the moment the file was last written: not later than that, and
     * usually not much earlier. Stamping them "now" instead would silently grant every
     * historical flag a fresh 30-day lease, which is the opposite of the intent.
     *
     * Missing savedAt falls back to now, which errs toward keeping the penalty rather
     * than discarding it, because a flag we cannot date is not evidence it was cleared. */
    const legacyFlagTs = Date.parse(parsed.savedAt || '') || Date.now();
    let migratedFlags = 0;
    for (const [k, v] of Object.entries(parsed.flags || {})) {
      if (Array.isArray(v)) { flags.set(k, v); continue; }
      const n = Math.max(0, Math.floor(Number(v) || 0));
      if (n === 0) continue;
      flags.set(k, Array(n).fill(legacyFlagTs));
      migratedFlags += n;
    }
    if (migratedFlags > 0) {
      console.log(`[oracle] migrated ${migratedFlags} legacy flag(s) to timestamps, dated ${new Date(legacyFlagTs).toISOString()}`);
    }
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
function creditPayment(didHash, txHash, amount, payer, success, now = Date.now(), packetId = null) {
  const key = txHash.toLowerCase();
  if (usedPaymentTxs.has(key)) return false;
  usedPaymentTxs.add(key);
  const list = paymentEvents.get(didHash) ?? [];
  // The settlement hash is kept, not just used for dedupe: it is what lets a third
  // party pull the payment off the chain and check it for themselves, which is the
  // whole point of committing to the evidence.
  //
  // packetId is corroboration, not evidence, and is deliberately NOT in the Merkle
  // leaf. Two reasons. Putting it there would change the leaf format and make roots
  // already published on chain unreproducible, which is a poor trade for a field a
  // verifier checks elsewhere anyway. And the corroboration works without it: the
  // verifier fetches that packet from CounterAudit directly, so Sigvara vouching for
  // the identifier adds nothing it could not confirm itself. /evidence says which
  // fields the root covers so this cannot be mistaken for a commitment.
  const event = { txHash: key, ts: now, amount: BigInt(amount).toString(), payer, success: !!success };
  if (packetId) event.packetId = String(packetId);
  paymentEvents.set(didHash, [...list, event]);
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
  addFlag,
  flagCount,
  decayedFlagCount,
  pruneFlags,
  resolveFlags,
  FLAG_HALF_LIFE_MS,
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
