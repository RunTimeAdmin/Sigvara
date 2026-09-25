// The evidence fixture in test/SigvaraReputation.t.sol, regenerated and compared.
//
// That fixture is the only thing checking that oracle/merkle.js and the contract agree on
// leaf encoding, pair ordering and odd-node handling. A disagreement passes both sides'
// own tests and fails only in production, which is precisely what it exists to catch.
//
// It was pinned as four bare hashes with no record of the payments behind them, so nobody
// could regenerate it or tell whether a leaf-format change had invalidated it. The inputs
// now live here, and this runs as a gate, so the fixture cannot drift from the code it
// claims to mirror.
//
// Run with --write to update the Solidity constants after a deliberate format change.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merkle = require('../oracle/merkle.js');

const SOL = 'test/SigvaraReputation.t.sol';

// Three payments, deliberately three so the tree has an odd node and the promotion path
// is covered. Outcomes are booleans because that is what the attested path produces; the
// third state (no outcome reported) encodes as uint8 2 and is covered in merkle.test.js.
const EVENTS = [
  { txHash: `0x${'11'.repeat(32)}`, payer: `0x${'a1'.repeat(20)}`, amount: '1000000', ts: 1_700_000_000_000, success: true },
  { txHash: `0x${'22'.repeat(32)}`, payer: `0x${'b2'.repeat(20)}`, amount: '2500000', ts: 1_700_086_400_000, success: true },
  { txHash: `0x${'33'.repeat(32)}`, payer: `0x${'c3'.repeat(20)}`, amount: '750000',  ts: 1_700_172_800_000, success: false },
];

const tree = merkle.buildTree(EVENTS);
const [leaf0, leaf1, leaf2] = tree.leaves;
// Sibling of the promoted odd leaf: the parent of the first pair.
const node01 = merkle.hashPair(leaf0, leaf1);

// Prove the proofs before publishing them, so a broken fixture cannot be written out.
for (let i = 0; i < EVENTS.length; i++) {
  if (!merkle.verifyProof(tree.leaves[i], merkle.proofFor(tree, i), tree.root)) {
    console.error(`evidence fixture: leaf ${i} does not verify against its own root`);
    process.exit(1);
  }
}

const expected = {
  EV_ROOT: tree.root,
  EV_LEAF0: leaf0,
  EV_LEAF1: leaf1,
  EV_LEAF2: leaf2,
  NODE01: node01,
};

let sol = readFileSync(SOL, 'utf8');
const found = {};
for (const name of ['EV_ROOT', 'EV_LEAF0', 'EV_LEAF1', 'EV_LEAF2']) {
  const m = sol.match(new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]{64})`));
  found[name] = m ? m[1].toLowerCase() : null;
}
const m2 = sol.match(/p\[0\] = (0x[0-9a-fA-F]{64});/);
found.NODE01 = m2 ? m2[1].toLowerCase() : null;

const write = process.argv.includes('--write');
const drift = Object.entries(expected).filter(([k, v]) => found[k] !== v.toLowerCase());

if (!drift.length) {
  console.log('evidence fixture check: ok (Solidity matches oracle/merkle.js)');
  process.exit(0);
}

if (!write) {
  console.error('evidence fixture check: FAILED — Solidity does not match oracle/merkle.js');
  for (const [k, v] of drift) console.error(`  ${k}\n    solidity: ${found[k]}\n    merkle.js: ${v.toLowerCase()}`);
  console.error('\nIf the leaf format changed on purpose, rerun with --write and review the diff.');
  process.exit(1);
}

for (const [k, v] of drift) {
  if (k === 'NODE01') sol = sol.replace(/p\[0\] = 0x[0-9a-fA-F]{64};/, `p[0] = ${v};`);
  else sol = sol.replace(new RegExp(`(${k}\\s*=\\s*)0x[0-9a-fA-F]{64}`), `$1${v}`);
}
writeFileSync(SOL, sol);
console.log(`evidence fixture: wrote ${drift.length} updated constant(s) to ${SOL}`);
