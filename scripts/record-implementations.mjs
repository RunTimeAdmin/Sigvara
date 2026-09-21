/**
 * Record which implementation each proxy is actually running, from the chain.
 *
 * Two upgrades shipped on 21 September and neither left a trace in this repo. The
 * deployment artifact records proxy addresses, which never change, and that is the
 * whole point of a proxy: the address is stable and the code behind it is not. So
 * "which code is live" was answerable only by reading a storage slot, and the honest
 * answer to "which commit is that" was a guess.
 *
 * The oracle's /health now reports its own commit, and this is the on-chain half of the
 * same question.
 *
 * It reads the ERC-1967 implementation slot rather than taking the upgrade script's
 * word for it. An implementation recorded because a broadcast was *attempted* is worth
 * very little; one read back from the chain afterwards is a fact. That also means this
 * catches an upgrade nobody recorded, which is the failure it exists for.
 *
 *   node scripts/record-implementations.mjs          # update the artifact
 *   node scripts/record-implementations.mjs --check  # fail if it disagrees with chain
 *
 * RPC_URL overrides the default endpoint.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

const CHAIN_ID = 5042002;
const RPC = process.env.RPC_URL || 'https://rpc.testnet.arc.io';
const ARTIFACT = join(root, 'deployments', `${CHAIN_ID}.json`);

/** keccak256("eip1967.proxy.implementation") - 1 */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// svrToken is a plain ERC-20, not a proxy, and has no implementation slot to read.
const PROXIES = ['identity', 'reputation', 'staking', 'oracleBond'];

const checkOnly = process.argv.includes('--check');

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const provider = new ethers.JsonRpcProvider(RPC);

async function implementationOf(proxy) {
  const raw = await provider.getStorage(proxy, IMPL_SLOT);
  const addr = ethers.getAddress('0x' + raw.slice(26));
  return addr === ethers.ZeroAddress ? null : addr;
}

const now = new Date().toISOString();
artifact.implementations ??= {};

let changed = 0;
const drift = [];

for (const name of PROXIES) {
  const proxy = artifact[name];
  if (!proxy) continue;

  const onChain = await implementationOf(proxy);
  if (!onChain) {
    console.error(`${name}: no implementation slot — not a proxy, or wrong address`);
    process.exitCode = 1;
    continue;
  }

  const entry = (artifact.implementations[name] ??= { current: null, history: [] });

  if (entry.current === onChain) {
    console.log(`${name.padEnd(11)} ${onChain}  (unchanged)`);
    continue;
  }

  drift.push(`${name}: artifact says ${entry.current ?? 'nothing'}, chain says ${onChain}`);

  if (checkOnly) continue;

  // Append rather than replace. The previous implementation is what a rollback targets
  // and what an incident review reads, so losing it defeats the purpose.
  if (entry.current) entry.history.push({ implementation: entry.current, replacedAt: now });
  entry.current = onChain;
  entry.recordedAt = now;
  changed++;
  console.log(`${name.padEnd(11)} ${onChain}  (updated)`);
}

if (checkOnly) {
  if (drift.length === 0) {
    console.log('implementations: artifact matches chain');
    process.exit(0);
  }
  console.error('implementations: artifact disagrees with chain\n');
  for (const d of drift) console.error(`  ${d}`);
  console.error('\nRun: node scripts/record-implementations.mjs');
  process.exit(1);
}

if (changed > 0) {
  writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`\n${changed} record(s) written to deployments/${CHAIN_ID}.json`);
} else {
  console.log('\nnothing to update');
}
