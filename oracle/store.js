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
const { stateChunks } = require('./state-serialize');
// The decay curve lives in payments.js. Imported rather than reimplemented so flags and
// payments age on exactly the same function; payments.js requires only ethers, so this
// direction of dependency is not circular.
const { decayWeight, WEIGHT_SCALE } = require('./payments');
const { numberSetting } = require('./config');

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
  numberSetting(process.env.FLAG_HALF_LIFE_DAYS, DEFAULT_FLAG_HALF_LIFE_DAYS) * 86_400_000;

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
// Settlements already credited, as `txHash|didHash`, so a receipt cannot be presented
// twice for the same agent. Keyed by the pair rather than the hash alone because one
// transaction can pay several agents: a batch payout, a multicall, a router settling a
// few providers at once. See creditKey.
const usedPaymentTxs = new Set();
// The latest acceptedAt given to a payer-signed outcome. Each is later than the one before, so
// GET /outcomes?since can page by it without losing or repeating one that shares a millisecond.
let lastAcceptedAt = 0;
// Payer-signed outcomes in the order they were taken, as { acceptedAt, did, tx, who }, so that
// GET /outcomes, which anyone may ask for, finds a page without reading every payment. Rebuilt on
// load; an entry whose payment has since been pruned is skipped when read.
let acceptedOrder = [];
// didHash -> recent occasions this oracle disagreed with a pending proposal, newest
// last. Only checker mode writes here. Persisted because a divergence is evidence for
// the slashing committee, and evidence that evaporates on restart is not evidence.
const divergences = new Map();
// Bounded so a permanently disagreeing pair of oracles cannot grow the state file
// without limit. The newest are the ones worth keeping: a committee acts inside the
// current challenge window, not on last month's.
const MAX_DIVERGENCES_PER_AGENT = 50;
// Long enough to cover any challenge window a committee could still act within, short
// enough that a permanently disagreeing pair does not accumulate for ever.
const DIVERGENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Where the AgentRegistered log scan got to, and what it found. Persisted so a
// restart resumes instead of replaying the chain from FROM_BLOCK, which grows with
// every block and eventually trips a public RPC's rate limit.
let scanState = null;
// Where the ERC-20 Transfer scan got to. Persisted for the same reason: a restart that
// replayed from FROM_BLOCK would grow with the chain and eventually never finish.
let paymentScanState = null;

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

// The format version of the state file. Written on every save and checked on load, so that
// a build older than the file refuses it instead of reading what it understands and then
// saving that over the rest. A file with no version predates this and is read as version 0.
const STATE_SCHEMA_VERSION = 1;

// The previous good state, one save behind. persist() keeps it by linking the live file here
// just before replacing it, which costs no copy.
const BACKUP_PATH = `${STATE_PATH}.bak`;

class StateLoadError extends Error {}

// How the last load went: 'fresh' (no file), 'file', or 'backup' (the file was unusable and
// the previous save was used instead). Reported by /health, so a recovery is not only a line
// in a log.
let loadReport = { source: 'none', detail: null };
function getLoadReport() { return { ...loadReport }; }

// The chain this state belongs to, once the oracle knows it. Saved with the state and
// compared with the chain the RPC reports, so that state from one chain is never used on
// another.
let stateChainId = null;
function getStateChainId() { return stateChainId; }
function setStateChainId(id) { stateChainId = id; }

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The contents of a state file as fresh data structures, or a throw.
 *
 * Nothing is touched here. load() used to fill the live maps as it parsed, so a throw part
 * way through left whatever had been read so far, and the rest missing: a failure after
 * attestations and before usedPaymentTxs meant the same settlement could be credited twice.
 * Parsing into new structures and applying them only once the whole file has read makes a
 * file either loaded or not loaded.
 */
function parseState(parsed) {
  if (!isObject(parsed)) throw new Error('the file does not hold a JSON object');

  const version = parsed.schemaVersion ?? 0;
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`schemaVersion ${JSON.stringify(parsed.schemaVersion)} is not a version number`);
  }
  if (version > STATE_SCHEMA_VERSION) {
    // Not recoverable from the backup: the backup is older than a file this build cannot
    // read, and loading it would save over everything the newer build recorded since.
    const err = new StateLoadError(
      `the state file is format version ${version} and this build reads up to ${STATE_SCHEMA_VERSION}. ` +
      'It was written by a newer version of the oracle; running this one would overwrite it with ' +
      'what it understands. Run the newer version, or restore a state file this one wrote.',
    );
    err.noFallback = true;
    throw err;
  }

  for (const key of ['attestations', 'flags', 'links', 'attestCooldowns', 'paymentEvents', 'divergences']) {
    if (parsed[key] !== undefined && parsed[key] !== null && !isObject(parsed[key])) {
      throw new Error(`${key} is not an object`);
    }
  }
  if (parsed.usedPaymentTxs !== undefined && !Array.isArray(parsed.usedPaymentTxs)) {
    throw new Error('usedPaymentTxs is not a list');
  }
  if (parsed.chainId !== undefined && parsed.chainId !== null && !Number.isInteger(parsed.chainId)) {
    throw new Error(`chainId ${JSON.stringify(parsed.chainId)} is not a whole number`);
  }

  const next = {
    attestations: new Map(),
    flags: new Map(),
    links: new Map(),
    attestCooldowns: new Map(),
    paymentEvents: new Map(),
    usedPaymentTxs: new Set(),
    divergences: new Map(),
    scanState: parsed.scanState || null,
    paymentScanState: parsed.paymentScanState || null,
    chainId: parsed.chainId ?? null,
  };

  for (const [k, v] of Object.entries(parsed.attestations || {})) next.attestations.set(k, v);
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
    if (Array.isArray(v)) { next.flags.set(k, v); continue; }
    const n = Math.max(0, Math.floor(Number(v) || 0));
    if (n === 0) continue;
    next.flags.set(k, Array(n).fill(legacyFlagTs));
    migratedFlags += n;
  }
  if (migratedFlags > 0) {
    console.log(`[oracle] migrated ${migratedFlags} legacy flag(s) to timestamps, dated ${new Date(legacyFlagTs).toISOString()}`);
  }
  for (const [k, v] of Object.entries(parsed.links || {})) next.links.set(k, v);
  for (const [k, v] of Object.entries(parsed.attestCooldowns || {})) next.attestCooldowns.set(k, v);
  // Validated at the boundary, because re-seeding paymentEvents by hand is ordinary
  // operational practice and the scoring maths converts these straight to BigInt. An
  // amount of '1.5' or '1_000_000', or a missing ts, throws four frames deep inside
  // decayWeight or decayedVolume, where the message names neither the agent nor the
  // field. Dropping the event names both and lets every other agent score.
  let badEvents = 0;
  let refiled = 0;
  for (const [k, v] of Object.entries(parsed.paymentEvents || {})) {
    const usable = (Array.isArray(v) ? v : []).filter((e) => {
      const why = paymentEventError(e);
      if (why) {
        badEvents += 1;
        console.warn(`[oracle] dropping unusable payment event for ${k}: ${why}`);
      }
      return !why;
    });
    if (!usable.length) continue;
    for (const e of usable) Object.freeze(e);
    // Keys are lowercase. A mixed-case key holds credits /attest filed before it
    // normalised the hash, where scoring never looked; folding them back in returns
    // those payments to the agent they paid.
    const key = k.toLowerCase();
    if (key !== k) refiled += usable.length;
    next.paymentEvents.set(key, Object.freeze([...(next.paymentEvents.get(key) ?? []), ...usable]));
  }
  if (refiled) {
    console.warn(`[oracle] refiled ${refiled} payment event(s) stored under a mixed-case didHash`);
  }
  if (badEvents) {
    console.error(
      `[oracle] ${badEvents} payment event(s) in the state file were unusable and have ` +
      'been dropped. Fee volume and tenure for those agents are understated until fixed.',
    );
  }
  for (const h of parsed.usedPaymentTxs || []) next.usedPaymentTxs.add(h);
  for (const [k, v] of Object.entries(parsed.divergences || {})) {
    // Re-applied on load, not just on write: a file that grew under an older build
    // would otherwise never shrink back inside the cap.
    if (Array.isArray(v)) next.divergences.set(k, v.slice(-MAX_DIVERGENCES_PER_AGENT));
  }
  return next;
}

// Replaces the live state with a parsed file. The maps are exported and shared, so they are
// emptied and refilled rather than replaced. Nothing here can throw.
function applyState(next) {
  attestations.clear();
  for (const [k, v] of next.attestations) attestations.set(k, v);
  flags.clear();
  for (const [k, v] of next.flags) flags.set(k, v);
  links.clear();
  for (const [k, v] of next.links) links.set(k, v);
  attestCooldowns.clear();
  for (const [k, v] of next.attestCooldowns) attestCooldowns.set(k, v);
  paymentEvents.clear();
  acceptedOrder = [];
  for (const [k, v] of next.paymentEvents) {
    paymentEvents.set(k, v);
    for (const e of v) {
      const at = e.payerOutcome?.acceptedAt;
      if (Number.isSafeInteger(at)) acceptedOrder.push({ acceptedAt: at, did: k, tx: e.txHash, who: String(e.payer).toLowerCase() });
    }
  }
  acceptedOrder.sort((x, y) => x.acceptedAt - y.acceptedAt);
  lastAcceptedAt = acceptedOrder.length ? acceptedOrder[acceptedOrder.length - 1].acceptedAt : 0;
  usedPaymentTxs.clear();
  for (const h of next.usedPaymentTxs) usedPaymentTxs.add(h);
  divergences.clear();
  for (const [k, v] of next.divergences) divergences.set(k, v);
  scanState = next.scanState;
  paymentScanState = next.paymentScanState;
  stateChainId = next.chainId;
}

function readStateFile(file) {
  return parseState(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * Load the state file. Throws StateLoadError when there is a file and nothing usable can be
 * made of it, and the caller is expected to stop.
 *
 * Any error but "no such file" used to be logged as "starting fresh", and the next save
 * wrote an empty state over the original. State here is what cannot be rebuilt from the
 * chain: attested outcomes, flags, links, and the record of which settlements were already
 * credited. One stray comma from editing the file by hand was enough to lose all of it, and
 * to credit the same settlement a second time.
 *
 *  - No file: a fresh start, as before. Deleting the file is the documented way to rescan.
 *    A backup left beside it is moved aside first (keepOrphanedBackup), not rotated away.
 *  - A file that reads: used.
 *  - A file that does not: the previous save (.bak) is used instead, the bad file is moved
 *    aside rather than overwritten, and /health says so.
 *  - Neither: refuse. Starting empty is the operator's call, made by moving the file away.
 */
function load() {
  let next;
  try {
    next = readStateFile(STATE_PATH);
    loadReport = { source: 'file', detail: null };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[oracle] no prior state at ${STATE_PATH}, starting fresh`);
      loadReport = { source: 'fresh', detail: null };
      keepOrphanedBackup();
      return;
    }
    if (err.noFallback) throw err;

    let backupWhy;
    try {
      next = readStateFile(BACKUP_PATH);
    } catch (backupErr) {
      backupWhy = backupErr.code === 'ENOENT'
        ? 'there is no backup from an earlier save'
        : `the backup from the previous save is unusable too (${backupErr.message})`;
    }
    if (!next) {
      throw new StateLoadError(
        `the state file ${STATE_PATH} cannot be used (${err.message}) and ${backupWhy}. ` +
        'Starting empty would lose the attestations, flags, links and payment records that cannot ' +
        'be rebuilt from the chain, and the next save would overwrite the file. Restore it from ' +
        'a backup, or move the file aside to start empty on purpose.',
      );
    }
    const aside = `${STATE_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(STATE_PATH, aside); } catch { /* the next save replaces it either way */ }
    loadReport = { source: 'backup', detail: err.message };
    console.error(
      `[oracle] RECOVERED: the state file was unusable (${err.message}); loaded the previous save from ` +
      `${BACKUP_PATH}. Anything recorded since that save is lost. The bad file was kept at ${aside}.`,
    );
  }
  applyState(next);
  console.log(`[oracle] state loaded from ${loadReport.source === 'backup' ? BACKUP_PATH : STATE_PATH}: ${attestations.size} attestations, ${flags.size} flags, ${links.size} links, ${attestCooldowns.size} cooldowns`);
}

/**
 * The outcome of the last persist attempt, so a failure is visible from outside.
 *
 * /health already probes the state path on every request, and gates its 503 on the
 * result. That probe is a proxy for this, not this: it writes a few bytes to a test file
 * and deletes it, so it passes while a real write of a multi-megabyte state file fails
 * for want of space, and it says nothing about a serialization error.
 *
 * The actual result was discarded. That mattered because the attest path answers on the
 * strength of having recorded something, and a persist that failed means it did not: the
 * payment is credited in memory, and a restart loses it. persist() now returns the result
 * too, and /attest answers 202 with `durable: false` instead of 200 when a save failed.
 * Scanned payments are found again on the next scan. Attested outcomes are not on chain
 * anywhere, so those are simply gone.
 */
let lastPersist = { ok: true, at: null, error: null };

function getLastPersist() {
  return { ...lastPersist };
}

/**
 * Why a stored payment event cannot be scored, or null when it can.
 *
 * Only the fields the arithmetic actually consumes. `payer` is allowed to be missing:
 * byPayer keys an absent payer as the empty string and the event still counts as volume,
 * which is the pre-existing behaviour and not something to start rejecting state over.
 */
function paymentEventError(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(e.txHash || ''))) {
    return `txHash is not a 32-byte hex string (${JSON.stringify(e.txHash)})`;
  }
  if (!Number.isFinite(Number(e.ts))) return `ts is not a finite number (${JSON.stringify(e.ts)})`;
  if (!/^\d+$/.test(String(e.amount))) {
    return `amount is not an integer string (${JSON.stringify(e.amount)})`;
  }
  return null;
}

/**
 * On a fresh start, move an existing backup out of the save rotation.
 *
 * With no live file, the backup is the only copy of the old state left, and the saves of
 * the fresh state rotate through BACKUP_PATH: the first removed it, the second replaced it
 * with the new empty state. The fresh start stays what the operator asked for; the old
 * state is kept beside it under its own name, as an unusable state file is.
 */
function keepOrphanedBackup() {
  if (!fs.existsSync(BACKUP_PATH)) return;
  const aside = `${BACKUP_PATH}.orphaned-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(BACKUP_PATH, aside);
    console.warn(`[oracle] a backup with no state file beside it was kept at ${aside}; restore it from there if the fresh start was not intended.`);
  } catch (err) {
    console.warn(`[oracle] could not move the backup ${BACKUP_PATH} aside (${err.message}); the next saves replace it.`);
  }
}

/**
 * Keep the state as it was before this save, as BACKUP_PATH.
 *
 * Linked, not copied: the live file and the backup share one inode until the rename that
 * follows gives the live path a new one, so the backup costs nothing and cannot be a
 * half-written copy. Filesystems without hard links fall back to a copy. A failure here
 * never fails the save; a backup is a safeguard, not the state.
 */
function keepBackup() {
  try {
    fs.rmSync(BACKUP_PATH, { force: true });
    fs.linkSync(STATE_PATH, BACKUP_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') return; // the first save: there is nothing to keep
    try { fs.copyFileSync(STATE_PATH, BACKUP_PATH); } catch { /* carry on without */ }
  }
}

// Write all of `text` to `fd`. fs.writeSync may write less than it was given, which writeFileSync
// used to take care of.
function writeAll(fd, text) {
  const bytes = Buffer.from(text, 'utf8');
  for (let done = 0; done < bytes.length;) done += fs.writeSync(fd, bytes, done, bytes.length - done);
}

/**
 * Write the state to disk. Returns whether the write landed, which is also what getLastPersist reports.
 *
 * It never throws: the oracle goes on serving from memory. A route that has just changed state and is about to
 * tell somebody it counted should read the result, because a failure here means a restart loses the change.
 */
function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      // Written in pieces rather than as one string: see state-serialize.js for why.
      for (const piece of stateChunks({
        schemaVersion: STATE_SCHEMA_VERSION,
        chainId: stateChainId,
        attestations: Object.fromEntries(attestations),
        flags: Object.fromEntries(flags),
        links: Object.fromEntries(links),
        attestCooldowns: Object.fromEntries(attestCooldowns),
        paymentEvents: Object.fromEntries(paymentEvents),
        usedPaymentTxs: [...usedPaymentTxs],
        divergences: Object.fromEntries(divergences),
        scanState,
        paymentScanState,
        savedAt: new Date().toISOString(),
      })) writeAll(fd, piece);
      // Flush before the rename. The rename is atomic, so a crash can never leave a
      // half-written state file, but without this it can leave an atomically-renamed
      // *empty* one: the directory entry is durable while the contents are still in the
      // page cache. Cheap insurance for the file that holds every attested outcome.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    keepBackup();
    fs.renameSync(tmp, STATE_PATH);
    lastPersist = { ok: true, at: Date.now(), error: null };
    return true;
  } catch (err) {
    lastPersist = { ok: false, at: Date.now(), error: err.message };
    console.error(`[oracle] state persist FAILED: ${err.message}`);
    return false;
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
/**
 * One settlement, one recipient.
 *
 * This was the transaction hash alone, which was right while an attestation was the only
 * way a payment arrived and named a single agent. The pull scanner reads every agent's
 * transfers out of the same logs, so a transaction crediting several agents is ordinary
 * traffic, and the bare hash silently discarded all but the first of them.
 *
 * Silently and permanently: creditPayment returns false, the scan counts it as neither
 * credited nor skipped, and the checkpoint moves past the block regardless, so nothing
 * ever looks at it again. The agent reads as one that was not paid, which is the exact
 * conclusion ADR 0003 exists to stop anyone drawing by accident.
 *
 * Nothing is weakened by narrowing the key. What stops a receipt being spent on an agent
 * it never paid is the recipient check, and that lives in both entry paths: verifyPayment
 * only counts transfers to the agent's own address, which is part of its DID and cannot
 * be repointed, and planCredits takes the agent from the log's own `to` field. The pair
 * is still refused a second time, so a genuine replay gains nothing.
 */
function creditKey(txHash, didHash, payer) {
  return [txHash, didHash, payer].map((x) => String(x).toLowerCase()).join('|');
}

/**
 * Whether this settlement has already been credited to this agent.
 *
 * A bare hash is an entry written before the key carried a recipient. It blocks every
 * agent, because which one it belonged to is not recoverable: prunePaymentEvents drops
 * old events and deliberately leaves this set alone, so the event may be long gone.
 * Refusing is the safe direction, and it only affects transactions credited before this
 * change.
 */
function isCredited(txHash, didHash, payer) {
  const tx = String(txHash).toLowerCase();
  // Three generations of key, oldest first. A shorter one blocks everything below it,
  // because what it omits is not recoverable: prunePaymentEvents drops old records and
  // deliberately leaves this set alone, so the record naming the agent or the sender may
  // be long gone. Refusing is the safe direction and only affects settlements credited
  // before each change.
  return usedPaymentTxs.has(tx)
    || usedPaymentTxs.has(`${tx}|${String(didHash).toLowerCase()}`)
    || usedPaymentTxs.has(creditKey(tx, didHash, payer));
}

function creditPayment(
  didHash, txHash, amount, payer, success, now = Date.now(), packetId = null, blockNumber = null,
) {
  const key = txHash.toLowerCase();
  // The same spelling isCredited uses. Filing under the caller's spelling while marking
  // the receipt used in lowercase let a mixed-case hash spend a payment where no score
  // would ever read it.
  const did = String(didHash).toLowerCase();
  if (isCredited(key, did, payer)) return false;
  usedPaymentTxs.add(creditKey(key, did, payer));
  const list = paymentEvents.get(did) ?? [];
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
  // `!!success` would turn null into false, which is precisely the error ADR 0003
  // exists to avoid: a payment pulled from the chain carries no outcome, and recording
  // it as a failure would damage an agent nobody complained about. Only a boolean is an
  // outcome; anything else is recorded as null and payments.hasOutcome keeps it out of
  // both sides of the success ratio.
  const outcome = typeof success === 'boolean' ? success : null;
  const event = { txHash: key, ts: now, amount: BigInt(amount).toString(), payer, success: outcome };
  if (packetId) event.packetId = String(packetId);
  // Where the settlement sits on the chain, when the caller knows it. Both entry paths
  // do: verifyPayment returns it and planCredits carries it, and neither used to keep it.
  //
  // Kept because the only other way to find it is eth_getTransactionReceipt, and both
  // live endpoints prune that index — measured 3 Oct 2026 at roughly 6 days on Circle's
  // and 13 on QuickNode's. The scan canary needs the block to re-issue its filter, so
  // without this it reported `unavailable` for every settlement older than the horizon,
  // which is to say for every settlement that matters.
  //
  // Corroboration, not evidence: it is absent from the Merkle leaf deliberately, since
  // committing to it would change the leaf format and make published roots
  // unreproducible. A verifier reads it off the chain anyway. Omitted rather than stored
  // as null when unknown, so the shape of an already-stored event does not change.
  if (Number.isInteger(blockNumber)) event.blockNumber = blockNumber;
  // Frozen, not copied. The evidence cache treats the array's identity as the revision
  // token, so handing out copies would turn every request into a miss; freezing keeps one
  // array per version and makes the "never mutated in place" rule the cache depends on
  // enforced rather than merely documented.
  // The event is frozen as well as the array: merkle.js caches a leaf against the event and a root
  // against the array, and that is only sound for values that cannot change.
  paymentEvents.set(did, Object.freeze([...list, Object.freeze(event)]));
  return true;
}

/**
 * Give an already-credited payment the outcome it was credited without.
 *
 * A payment found by the scan, or attested by someone who holds no token, is credited with
 * no outcome (see payments.hasOutcome). When a credential holder later reports one for the
 * same settlement, that report must not be refused as a replay: the earlier credit said
 * nothing about how the work went, and refusing meant whoever credited a payment first
 * could keep the party who audited it from ever recording the result.
 *
 * Once an outcome is recorded it is final. Changing it would let a later caller overwrite an
 * audited result, so a second report gets 'already_set'.
 *
 * The reporter's packetId goes on with the outcome when the payment has none. Without it, a
 * payment the scan found first could never carry the auditor's record, since the scan has
 * none to give. One the payment already has is kept.
 *
 * @returns {'set'|'already_set'|'not_found'} not_found when no event matches: it was pruned,
 *          or the credit predates keys that name the sender.
 */
function setPaymentOutcome(didHash, txHash, payer, success, packetId = null) {
  if (typeof success !== 'boolean') throw new TypeError('setPaymentOutcome: success must be a boolean');
  const did = String(didHash).toLowerCase();
  const tx = String(txHash).toLowerCase();
  const who = String(payer).toLowerCase();
  const list = paymentEvents.get(did) ?? [];
  const i = list.findIndex((e) => e.txHash === tx && String(e.payer).toLowerCase() === who);
  if (i < 0) return 'not_found';
  if (typeof list[i].success === 'boolean') return 'already_set';
  // A new array, not an edit in place: the evidence cache treats the array's identity as
  // the revision token, so a changed outcome has to be a new identity.
  const next = [...list];
  next[i] = Object.freeze({
    ...list[i],
    success,
    ...(packetId && !list[i].packetId ? { packetId: String(packetId) } : {}),
  });
  paymentEvents.set(did, Object.freeze(next));
  return 'set';
}

/**
 * Records an outcome the payer signed for its own leg of a credited payment
 * (docs/adr/0006-payer-signed-outcomes.md, section 4).
 *
 * - A payer-signed outcome is final for its leg: a second one is refused, whatever it says.
 * - It replaces a credentialed outcome on the same leg if it arrives within `windowMs` of the
 *   payment's block time (the event's `ts`), since the payer is the party the work was for, and
 *   only when `replaceable` (the transaction had this one paying leg): a credentialed outcome on
 *   a transaction with several payers was given for the whole job. The credential holder's
 *   packetId goes with the outcome it backed.
 * - A credentialed outcome never replaces it: setPaymentOutcome refuses any leg that has one.
 *
 * `signed` is the payload and signature, kept beside the event so a verifier can check that
 * the committed outcome is one the payer signed. The evidence leaf is unchanged: it commits to
 * `success` as before. It gains `acceptedAt`, this host's time of taking it and later than any
 * before it, which GET /outcomes pages by.
 *
 * `now` is when the outcome arrived for the window: the time of the block its signature was
 * checked at, so an operator importing it later reaches the same answer.
 *
 * `packetId` is the CounterAudit packet that sealed this outcome, as its carrier named it
 * (payerOutcome.packetIdOf). It takes the place of the credential holder's, and like that one it
 * is corroboration, not evidence, and stays out of the leaf.
 *
 * @returns {'set'|'replaced'|'already_set'|'outside_window'|'not_found'}
 */
function recordPayerOutcome(
  didHash, txHash, payer, success, signed, { windowMs, replaceable = true, now = Date.now(), packetId = null },
) {
  if (typeof success !== 'boolean') throw new TypeError('recordPayerOutcome: success must be a boolean');
  const did = String(didHash).toLowerCase();
  const tx = String(txHash).toLowerCase();
  const who = String(payer).toLowerCase();
  const list = paymentEvents.get(did) ?? [];
  const i = list.findIndex((e) => e.txHash === tx && String(e.payer).toLowerCase() === who);
  if (i < 0) return 'not_found';
  const event = list[i];
  if (event.payerOutcome) return 'already_set';
  const credentialed = typeof event.success === 'boolean';
  if (credentialed && (!replaceable || now - event.ts > windowMs)) return 'outside_window';
  const { packetId: _backedTheOldOutcome, ...rest } = event;
  lastAcceptedAt = Math.max(Date.now(), lastAcceptedAt + 1);
  const next = [...list];
  next[i] = Object.freeze({
    ...rest,
    success,
    ...(packetId ? { packetId: String(packetId) } : {}),
    payerOutcome: Object.freeze({ ...signed, acceptedAt: lastAcceptedAt }),
  });
  paymentEvents.set(did, Object.freeze(next));
  acceptedOrder.push({ acceptedAt: lastAcceptedAt, did, tx, who });
  return credentialed ? 'replaced' : 'set';
}

/**
 * The payer-signed outcomes accepted after `since` (an acceptedAt), oldest first, at most
 * `limit` of them, for GET /outcomes. `more` says whether any were left out.
 */
function payerOutcomesSince(since, limit) {
  // The first entry after `since`.
  let lo = 0;
  let hi = acceptedOrder.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (acceptedOrder[mid].acceptedAt > since) hi = mid;
    else lo = mid + 1;
  }
  const outcomes = [];
  let i = lo;
  for (; i < acceptedOrder.length && outcomes.length < limit; i += 1) {
    const { acceptedAt, did, tx, who } = acceptedOrder[i];
    const e = (paymentEvents.get(did) ?? []).find(
      (x) => x.txHash === tx && String(x.payer).toLowerCase() === who && x.payerOutcome?.acceptedAt === acceptedAt,
    );
    if (e) {
      outcomes.push({
        didHash: did,
        txHash: e.txHash,
        payer: e.payer,
        ...e.payerOutcome,
        ...(e.packetId ? { counterauditPacketId: e.packetId } : {}),
      });
    }
  }
  return { outcomes, more: i < acceptedOrder.length };
}

/** The payer-signed outcome this oracle holds for a leg, or null. */
function payerOutcomeFor(didHash, txHash, payer) {
  const tx = String(txHash).toLowerCase();
  const who = String(payer).toLowerCase();
  const e = (paymentEvents.get(String(didHash).toLowerCase()) ?? []).find(
    (x) => x.payerOutcome && x.txHash === tx && String(x.payer).toLowerCase() === who,
  );
  return e ? e.payerOutcome : null;
}

/** Whether the payer has signed an outcome for its leg of this payment. */
function hasPayerOutcome(didHash, txHash, payer) {
  const tx = String(txHash).toLowerCase();
  const who = String(payer).toLowerCase();
  return (paymentEvents.get(String(didHash).toLowerCase()) ?? []).some(
    (e) => e.payerOutcome && e.txHash === tx && String(e.payer).toLowerCase() === who,
  );
}

/** Every agent's payment log. Read-only use: the canary picks a known settlement. */
function allPaymentEvents() { return paymentEvents; }

function getPaymentEvents(didHash) {
  return paymentEvents.get(String(didHash).toLowerCase()) ?? [];
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
    else if (kept.length !== list.length) paymentEvents.set(did, Object.freeze(kept));
  }
  return dropped;
}

/**
 * Record that this oracle's score differed from the one pending on chain.
 *
 * Checker mode only. The entry carries both totals and the per-factor deltas, because
 * "the score is wrong" is not actionable and "successScore says 25, we compute 7" is.
 * proposedAt is kept so a reader can tell whether the disputed proposal is still inside
 * its challenge window, which is the difference between a live alert and a post-mortem.
 */
/**
 * `evidence` is what makes a record diagnosable by someone who was not there.
 *
 * Factor deltas alone say the two operators disagree. They do not say why, and the most
 * common why is not arithmetic: it is that one operator holds payment evidence the other
 * was never sent, because attestations arrive per-operator over HTTP. Recording each
 * side's evidence root and the checker's own event count turns "they disagree" into
 * "they were scoring different evidence, go and diff it", which a stranger can act on
 * using public endpoints alone.
 */
function recordDivergence(didHash, divergence, proposedAt, now = Date.now(), evidence = null) {
  const list = divergences.get(didHash) || [];
  list.push({
    at: now,
    proposedAt,
    pendingTotal: divergence.pendingTotal,
    ownTotal: divergence.ownTotal,
    factors: divergence.factors,
    ...(evidence ? { evidence } : {}),
  });
  divergences.set(didHash, list.slice(-MAX_DIVERGENCES_PER_AGENT));
  return true;
}

function getDivergences(didHash) { return divergences.get(didHash) || []; }

/**
 * Drop divergences older than `maxAgeMs`, and any agent left with none.
 *
 * Bounded per agent already; this bounds the number of agents. A committee acts inside
 * a six-hour challenge window, so a divergence from last quarter is not evidence it can
 * still use, and the whole map is re-serialised on every persist().
 */
function pruneDivergences(maxAgeMs = DIVERGENCE_MAX_AGE_MS, now = Date.now()) {
  let dropped = 0;
  for (const [didHash, list] of divergences) {
    const kept = list.filter(e => now - (e.at ?? 0) <= maxAgeMs);
    dropped += list.length - kept.length;
    if (kept.length === 0) divergences.delete(didHash);
    else if (kept.length !== list.length) divergences.set(didHash, kept);
  }
  return dropped;
}

function forgetAgent(didHash) { return divergences.delete(didHash); }

function allDivergences() { return Object.fromEntries(divergences); }

function getScanState() { return scanState; }
function setScanState(state) { scanState = state; }

/**
 * Where the payment scan got to.
 *
 * Its own checkpoint, separate from the registration scan, because the two advance at
 * different rates and share nothing but a chain. Folding them together would mean a
 * rate-limited payment scan dragging the agent scan backwards with it.
 */
function getPaymentScanState() { return paymentScanState; }
function setPaymentScanState(state) { paymentScanState = state; }

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
  creditKey,
  isCredited,
  getLastPersist,
  paymentEventError,
  creditPayment,
  setPaymentOutcome,
  recordPayerOutcome,
  hasPayerOutcome,
  payerOutcomesSince,
  payerOutcomeFor,
  divergences,
  recordDivergence,
  getDivergences,
  allDivergences,
  pruneDivergences,
  forgetAgent,
  MAX_DIVERGENCES_PER_AGENT,
  DIVERGENCE_MAX_AGE_MS,
  getScanState,
  setScanState,
  getPaymentScanState,
  setPaymentScanState,
  getPaymentEvents,
  allPaymentEvents,
  paymentVolume,
  prunePaymentEvents,
  load,
  persist,
  StateLoadError,
  getLoadReport,
  getStateChainId,
  setStateChainId,
  STATE_SCHEMA_VERSION,
  BACKUP_PATH,
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
  ATTEST_COOLDOWN_MS,
};
