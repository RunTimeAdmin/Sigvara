#!/usr/bin/env node
/**
 * Fails when a tracked file looks like it holds a private key.
 *
 * GitHub's push protection matches the token formats of known providers. A raw EVM or
 * Ed25519 private key is just 64 hex characters, so it matches nothing there and would sit
 * in public history for good. This is the second line of defence after .gitignore:
 *
 *   - a PEM or OpenSSH private key block, or
 *   - 64 hex characters (optionally 0x-prefixed) assigned to a name that says key, secret,
 *     seed, signer or private, or a mnemonic phrase assigned to a name that says mnemonic.
 *
 * It prints the file and line and never the value.
 *
 *   node scripts/check-secrets.mjs            every tracked file (CI)
 *   node scripts/check-secrets.mjs --staged   what is staged right now (pre-commit hook)
 *   node scripts/check-secrets.mjs --self-test
 *
 * A known public test key is allowed by listing its hex below. One line can opt out with the
 * words "secret-scan: allow" on the same line, for a fixture that cannot be listed.
 * SKIP_SECRET_SCAN=1 skips the whole check (hook only, never in CI).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Public by construction: the first account of the anvil and hardhat development mnemonic.
const PUBLIC_TEST_KEYS = new Set([
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
]);

const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const NAME = '(?:priv(?:ate)?[_ -]?key|secret(?:[_ -]?key)?|seed|signer[_ -]?key|signing[_ -]?key|[a-z0-9_]*_pk|\\bpk)';
const HEX_ASSIGN = new RegExp(`${NAME}["']?\\s*[:=]\\s*["']?(?:0x)?([0-9a-fA-F]{64})\\b`, 'i');
const MNEMONIC = /mnemonic["']?\s*[:=]\s*["']?(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}/i;
const MAX_BYTES = 2_000_000;

export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan: allow')) return;
    if (PEM.test(line)) { hits.push({ line: i + 1, kind: 'private key block' }); return; }
    const m = HEX_ASSIGN.exec(line);
    if (m && !PUBLIC_TEST_KEYS.has(m[1].toLowerCase())) { hits.push({ line: i + 1, kind: '64 hex characters assigned to a key-like name' }); return; }
    if (MNEMONIC.test(line)) hits.push({ line: i + 1, kind: 'mnemonic phrase' });
  });
  return hits;
}

function selfTest() {
  const h64 = 'ab'.repeat(32);
  const cases = [
    [`ORACLE_PRIVATE_KEY=0x${h64}`, 1], [`const privateKey = "${h64}"`, 1], [`"seed": "0x${h64}"`, 1],
    [`PK: ${h64}`, 1], ['-----BEGIN OPENSSH PRIVATE KEY-----', 1],
    [`mnemonic = "${Array(12).fill('abandon').join(' ')}"`, 1],
    [`txHash = 0x${h64}`, 0], [`didHash: ${h64}`, 0], [`ORACLE_PRIVATE_KEY=0x${h64} // secret-scan: allow`, 0],
    [`key=0x${[...PUBLIC_TEST_KEYS][0]}`, 0], ['ORACLE_PRIVATE_KEY=0x...', 0],
  ];
  let bad = 0;
  for (const [text, want] of cases) {
    const got = scanText(text).length;
    if (got !== want) { bad++; console.error(`self-test: expected ${want} hit(s), got ${got} for case starting "${text.slice(0, 24)}"`); }
  }
  if (bad) process.exit(1);
  console.log(`check-secrets self-test ok (${cases.length} cases)`);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (process.env.SKIP_SECRET_SCAN === '1' && args.includes('--staged')) return;

  const staged = args.includes('--staged');
  const names = (staged
    ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    : git(['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean);

  let found = 0;
  for (const name of names) {
    let buf;
    try { buf = staged ? git(['show', `:${name}`]) : readFileSync(name); } catch { continue; }
    if (buf.length > MAX_BYTES || buf.subarray(0, 8000).includes(0)) continue;
    for (const h of scanText(buf.toString('utf8'))) {
      found++;
      console.error(`${name}:${h.line}: ${h.kind} (value not shown)`);
    }
  }
  if (found) {
    console.error(`\ncheck-secrets: ${found} possible private key${found > 1 ? 's' : ''}. If a value is a public test key, add its hex to PUBLIC_TEST_KEYS in scripts/check-secrets.mjs or put "secret-scan: allow" on that line.`);
    process.exit(1);
  }
  console.log(`check-secrets: ${names.length} ${staged ? 'staged' : 'tracked'} file(s) scanned, no private key found`);
}

main();
