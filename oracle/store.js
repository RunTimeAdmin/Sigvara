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
// didHash → { volume: string (base units, BigInt-as-string), count } of verified payments.
// Stored as a string because JSON has no BigInt and the volume can exceed 2^53 on an
// 18-decimal token.
const payments = new Map();
// Settlement tx hashes already credited, so a receipt cannot be presented twice.
const usedPaymentTxs = new Set();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(parsed.attestations || {})) attestations.set(k, v);
    for (const [k, v] of Object.entries(parsed.flags || {})) flags.set(k, v);
    for (const [k, v] of Object.entries(parsed.links || {})) links.set(k, v);
    for (const [k, v] of Object.entries(parsed.attestCooldowns || {})) attestCooldowns.set(k, v);
    for (const [k, v] of Object.entries(parsed.payments || {})) payments.set(k, v);
    for (const h of parsed.usedPaymentTxs || []) usedPaymentTxs.add(h);
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
      payments: Object.fromEntries(payments),
      usedPaymentTxs: [...usedPaymentTxs],
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
function creditPayment(didHash, txHash, amount) {
  const key = txHash.toLowerCase();
  if (usedPaymentTxs.has(key)) return false;
  usedPaymentTxs.add(key);
  const current = payments.get(didHash) ?? { volume: '0', count: 0 };
  payments.set(didHash, {
    volume: (BigInt(current.volume) + BigInt(amount)).toString(),
    count: current.count + 1,
  });
  return true;
}

function paymentVolume(didHash) {
  return BigInt((payments.get(didHash) ?? { volume: '0' }).volume);
}

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
  links,
  attestCooldowns,
  payments,
  usedPaymentTxs,
  creditPayment,
  paymentVolume,
  load,
  persist,
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
  ATTEST_COOLDOWN_MS,
};
