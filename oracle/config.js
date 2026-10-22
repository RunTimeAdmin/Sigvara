'use strict';

// Pre-flight check of the numeric settings, so a typo stops the process instead of turning
// a control off.
//
// The modules read their own settings, and most of them did `Number(env.X ?? default)`.
// Number('four') is NaN, and every comparison against NaN is false, so the failures were
// quiet and in the unsafe direction: PAYMENT_MAX_PER_PAYER=four removed the per-payer cap
// (one wallet could reach 20 points), PAYMENT_HALF_LIFE_DAYS=90d removed decay, 4.5 threw
// for every agent at epoch time, and a watcher with MAX_SILENCE_MINUTES=2h never decided a
// checker was silent. EPOCH_HOURS and DIVERGENCE_TOLERANCE already refuse to start for
// this reason; this extends the same rule to the rest.
//
// This validates, and parses only where parsing mattered. A value that is set and is not a
// sane number is refused. A blank value means unset, which is how a template says it and what
// a compose passthrough leaves behind. Four settings used to read a blank as zero and so
// switched a control off; those go through numberSetting below.

// [name, kind, min, max]. kind: 'int' whole number, 'num' any finite number, 'bigint' a
// whole number written as digits (amounts in base units, which overflow a JSON number).
const NUMERIC = [
  ['PORT', 'int', 1, 65535],
  ['FROM_BLOCK', 'int', 0],
  ['LOG_CHUNK_SIZE', 'int', 1],
  ['ATTEST_COOLDOWN_MS', 'int', 0],
  ['FLAG_HALF_LIFE_DAYS', 'num', 0],
  ['PAYMENT_MIN_AMOUNT', 'bigint', 0],
  ['PAYMENT_MIN_CONFIRMATIONS', 'int', 1],
  ['PAYMENT_FEE_UNIT', 'bigint', 1],
  ['PAYMENT_HALF_LIFE_DAYS', 'num', 0],
  ['PAYMENT_MAX_PER_PAYER', 'int', 0],
  ['PAYMENT_TRUST_WEIGHT', 'num', 0, 10],
  ['PAYMENT_SCAN_FROM_BLOCK', 'int', 0],
  ['PAYMENT_SCAN_CHUNK', 'int', 1],
  ['PAYMENT_SCAN_CONFIRMATIONS', 'int', 0],
  ['PAYMENT_SCAN_PACE_MS', 'int', 0],
  ['JOBS_FROM_BLOCK', 'int', 0],
  ['JOBS_MAX_SPAN', 'int', 1],
  ['EXPECTED_CHAIN_ID', 'int', 1],
  ['TX_WAIT_SECONDS', 'num', 5, 3600],
  ['MAX_FEE_GWEI', 'num', 0.000001],
  ['MAX_TX_COST', 'num', 0.000001],
  ['MAX_CLOCK_SKEW_SECONDS', 'num', 1],
  // The watcher's. POLL_SECONDS is also checked there, with its own message.
  ['POLL_SECONDS', 'num', 30],
  ['MAX_SILENCE_MINUTES', 'num', 1],
  ['FINAL_WARNING_MINUTES', 'num', 0],
];

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Why a value cannot be used, or null when it can.
 * @param {string} raw
 * @param {'int'|'num'|'bigint'} kind
 */
function numberProblem(raw, kind, min = -Infinity, max = Infinity) {
  const s = String(raw).trim();
  if (kind === 'bigint') {
    if (!/^\d+$/.test(s)) return 'is not a whole number written as digits';
    return Number.isFinite(min) && BigInt(s) < BigInt(Math.ceil(min)) ? `is below the minimum of ${min}` : null;
  }
  // Number() alone accepts '0x10', 'Infinity' and '' (as 0). Only a plain decimal number
  // is a setting.
  if (!PLAIN_NUMBER.test(s) || !Number.isFinite(Number(s))) return 'is not a number';
  const n = Number(s);
  if (kind === 'int' && !Number.isInteger(n)) return 'is not a whole number';
  if (n < min) return `is below the minimum of ${min}`;
  if (n > max) return `is above the maximum of ${max}`;
  return null;
}

/**
 * Every setting that is present and unusable, as a line each. Empty means all is well.
 * A blank value is skipped: it is how a template says "unset".
 */
function checkNumericConfig(env = process.env) {
  const problems = [];
  for (const [name, kind, min, max] of NUMERIC) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    const why = numberProblem(raw, kind, min, max);
    if (why) problems.push(`${name}="${String(raw).slice(0, 40)}" ${why}`);
  }
  return problems;
}

/** Exit with every problem listed, or return. For the entry points. */
function requireValidNumericConfig(label, env = process.env) {
  const problems = checkNumericConfig(env);
  if (problems.length === 0) return;
  console.error(`[${label}] these settings are not usable, and are refused rather than guessed at:`);
  for (const p of problems) console.error(`[${label}]   ${p}`);
  process.exit(1);
}

/**
 * A numeric setting, with a blank value read as unset.
 *
 * `Number(env.X ?? fallback)` only falls back on undefined. A blank X (`PAYMENT_MAX_PER_PAYER=`)
 * is the empty string, and Number('') is 0, which for these settings means "off": no per-payer cap,
 * no payment decay, no trust weighting, no flag decay. checkNumericConfig and the README both treat
 * a blank as unset, so the modules have to as well. A value that is set is parsed as it always was,
 * and 0 still disables where it is documented to.
 */
function numberSetting(raw, fallback) {
  return raw === undefined || String(raw).trim() === '' ? fallback : Number(raw);
}

/**
 * Why ORACLE_MODE cannot be used, or null. Unset, blank or `primary` runs a primary and
 * `checker` a checker, exactly as written. Anything else used to run a primary without a
 * word: `CHECKER` or `Checker` on the checker host would then overwrite and finalize the
 * real primary's proposals, the one thing a checker must never do.
 */
function oracleModeError(raw) {
  // Untrimmed, because index.js compares it exactly: ' checker' would pass a trimmed check
  // and still run a primary.
  if (raw === undefined || ['', 'primary', 'checker'].includes(raw)) return null;
  return `ORACLE_MODE="${String(raw).slice(0, 40)}" is not a mode: leave it unset (or primary), or set checker`;
}

module.exports = {
  checkNumericConfig, requireValidNumericConfig, numberProblem, numberSetting, oracleModeError, NUMERIC,
};
