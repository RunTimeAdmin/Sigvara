/**
 * The last check before the step that cannot be undone, and the one script/SplitAuthority.s.sol's
 * renounce phase will not run without (the owner's decision, 2026-11-02: a hard gate).
 *
 * The renounce phase reads the contracts as they are. Two things are only in the chain's history:
 *
 *   1. Who holds every role. AccessControl cannot list holders, so a grant nobody expected shows
 *      only in the events. scripts/check-role-holders.mjs replays them, with BEFORE_RENOUNCE=1.
 *   2. Everything the Safe has done since it was made (scripts/safe-history.mjs). Safe reads who may
 *      act from storage its getters list only in part, so a Safe that ever let other code run as
 *      itself, by DelegateCall or through a module, may have someone acting for it that no getter
 *      shows. The Safe must be a SafeL2, whose log records each transaction's operation.
 *
 * When both pass, it writes deployments/<chain>.renounce-check.json with the head it read, the
 * Safe's nonce and the deployer's. The renounce phase refuses a report that failed, is for another
 * chain, Safe, timelock or deployer, is over an hour old, or that the Safe or the deployer has made
 * a transaction since. A run that fails removes the old report first.
 *
 *   SAFE=0x.. TIMELOCK=0x.. COMMITTEE=0x.. ORACLE=0x.. GUARDIAN=0x.. SAFE_CREATION_BLOCK=n \
 *     node scripts/check-before-renounce.mjs
 *   node scripts/check-before-renounce.mjs --self-test
 *
 * SAFE_CREATION_BLOCK is the block the Safe was made in (or any block before it). CHAIN_ID
 * (default 5042, mainnet) and RPC_URL pick the chain, for a rehearsal; check-role-holders.mjs reads
 * the same two. MAX_RANGE and PACE_MS work as they do there.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assessSafeHistory, safeL2Of, readSafeHistory, MULTI_SEND_CALL_ONLY } from './safe-history.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

const SCHEMA = 'sigvara/renounce-check/v1';

if (process.argv.includes('--self-test')) process.exit(selfTest());

const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const RPC = process.env.RPC_URL || (CHAIN_ID === 5042 ? 'https://rpc.mainnet.arc.io' : null);
const RANGE = Number(process.env.MAX_RANGE || 10000);
const PACE_MS = Number(process.env.PACE_MS || 500);
const REPORT = join(root, 'deployments', `${CHAIN_ID}.renounce-check.json`);

// Whatever happens below, no report from an earlier run stays to be taken for this one.
rmSync(REPORT, { force: true });

const stop = (msg) => { console.log(`FAIL  ${msg}`); console.log('before the renounce: STOP, no report written'); process.exit(1); };
if (!RPC) stop('set RPC_URL for a chain other than 5042');
const SAFE = process.env.SAFE;
const TIMELOCK = process.env.TIMELOCK;
if (!SAFE || !ethers.isAddress(SAFE)) stop('SAFE is not set to an address');
if (!TIMELOCK || !ethers.isAddress(TIMELOCK)) stop('TIMELOCK is not set to an address');
const fromBlock = Number(process.env.SAFE_CREATION_BLOCK);
if (!Number.isInteger(fromBlock) || fromBlock < 0) stop('SAFE_CREATION_BLOCK is not set to the block the Safe was made in');
const artifact = JSON.parse(readFileSync(join(root, 'deployments', `${CHAIN_ID}.json`), 'utf8'));
if (!ethers.isAddress(artifact.deployer)) stop(`deployments/${CHAIN_ID}.json has no deployer`);

console.log('== 1. role holders, from the grant history ==');
const roles = spawnSync(process.execPath, [join(root, 'scripts', 'check-role-holders.mjs')], {
  env: { ...process.env, BEFORE_RENOUNCE: '1', CHAIN_ID: String(CHAIN_ID), RPC_URL: RPC },
  stdio: 'inherit',
});
if (roles.status !== 0) stop('the role holders do not reconcile (above)');

console.log("== 2. the Safe's history, from its own log ==");
// No cached answers: everything is read at one head, and it must be the real one.
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) stop(`${RPC} is not chain ${CHAIN_ID}`);
// Everything is read at one block, so the report describes one moment.
const head = await provider.getBlock('latest');
const at = head.number;
const l2 = await safeL2Of(provider, SAFE, at);
if (!l2.ok) stop(l2.reason);
console.log(`ok    the Safe is a Safe proxy running ${l2.name}`);
const safe = new ethers.Contract(SAFE, [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
], provider);
const nonce = Number(await safe.nonce({ blockTag: at }));
const owners = (await safe.getOwners({ blockTag: at })).map((o) => o.toLowerCase());
const threshold = Number(await safe.getThreshold({ blockTag: at }));
const entries = await readSafeHistory(provider, SAFE, fromBlock, at, { range: RANGE, paceMs: PACE_MS });
const problems = assessSafeHistory({ entries, nonce, owners, threshold });
// The batch contract a DelegateCall went to must hold the code Safe published for it.
for (const to of new Set(entries.filter((e) => e.name === 'SafeMultiSigTransaction' && e.operation === 1).map((e) => e.to))) {
  if (MULTI_SEND_CALL_ONLY.has(to) && ethers.keccak256(await provider.getCode(to, at)) !== MULTI_SEND_CALL_ONLY.get(to)) {
    problems.push(`${to} does not hold the MultiSendCallOnly code Safe lists for it`);
  }
}
for (const p of problems) console.log(`FAIL  ${p}`);
if (problems.length > 0) stop("the Safe's history does not reconcile (above)");
console.log(`ok    ${nonce} transactions from block ${fromBlock} to ${at}, none ran other code as the Safe or through a module`);
console.log(`ok    owners [${owners.join(', ')}] and threshold ${threshold}, as the log gives them`);

const deployerNonce = await provider.getTransactionCount(artifact.deployer, at);
writeFileSync(REPORT, `${JSON.stringify({
  schema: SCHEMA,
  passed: true,
  chain_id: CHAIN_ID,
  safe: ethers.getAddress(SAFE),
  timelock: ethers.getAddress(TIMELOCK),
  deployer: ethers.getAddress(artifact.deployer),
  checked_block: at,
  checked_at: head.timestamp,
  safe_nonce: nonce,
  deployer_nonce: deployerNonce,
}, null, 2)}\n`);
console.log(`before the renounce: all checks passed. Wrote deployments/${CHAIN_ID}.renounce-check.json, good for an hour while neither the Safe nor the deployer makes a transaction.`);

/** The history rules on made-up logs: each way to fail, and a history that passes. */
function selfTest() {
  const a = (n) => `0x${String(n).padStart(40, '0')}`;
  const OWNERS = [a(1), a(2), a(3)];
  const setup = { name: 'SafeSetup', txHash: '0xc0', owners: OWNERS, threshold: 2 };
  const tx = (operation, to = a(9), txHash = '0xt') => ({ name: 'SafeMultiSigTransaction', txHash, to, operation });
  const ran = (hash) => ({ name: 'ExecutionSuccess', txHash: '0xt', safeTxHash: hash });
  const MULTI = [...MULTI_SEND_CALL_ONLY.keys()][2];
  const base = { nonce: 2, owners: OWNERS, threshold: 2 };
  const cases = [
    ['passes: calls, a batch through MultiSendCallOnly, an approval that ran, the L2 switch at creation',
      [setup, { name: 'ChangedMasterCopy', txHash: '0xc0', address: a(7) }, tx(0), ran('0xh1'), tx(1, MULTI),
        { name: 'ApproveHash', txHash: '0xa', safeTxHash: '0xh2', owner: a(1) }, ran('0xh2')], base, null],
    ['a DelegateCall to anything else', [setup, tx(0), tx(1, a(8))], base, 'DelegateCalled'],
    ['a module acting', [setup, tx(0), tx(0), { name: 'SafeModuleTransaction', txHash: '0xm', module: a(5), to: a(9) }], base, 'acted for the Safe'],
    ['a module enabled', [setup, tx(0), tx(0), { name: 'EnabledModule', txHash: '0xe', address: a(5) }], base, 'was enabled'],
    ['the implementation changed later', [setup, tx(0), tx(0), { name: 'ChangedMasterCopy', txHash: '0xl', address: a(7) }], base, 'after it was made'],
    ['fewer logged transactions than the nonce', [setup, tx(0)], base, 'nonce is 2'],
    ['an owner the log does not explain', [setup, tx(0), tx(0)], { ...base, owners: [...OWNERS, a(4)] }, 'the Safe answers'],
    ['a threshold the log does not explain', [setup, tx(0), tx(0)], { ...base, threshold: 1 }, 'threshold of 2'],
    ['an owner change the log does explain', [setup, tx(0), { name: 'AddedOwner', txHash: '0xo', address: a(4) },
      { name: 'ChangedThreshold', txHash: '0xo', threshold: 3 }, tx(0)], { ...base, owners: [...OWNERS, a(4)], threshold: 3 }, null],
    ['an approval waiting for a later transaction', [setup, tx(0), tx(0), { name: 'ApproveHash', txHash: '0xa', safeTxHash: '0xh9', owner: a(2) }], base, 'has not run'],
    ['no SafeSetup in the range read', [tx(0), tx(0)], base, 'no SafeSetup'],
  ];
  let failed = 0;
  for (const [what, entries, state, expected] of cases) {
    const problems = assessSafeHistory({ entries, ...state });
    const good = expected === null ? problems.length === 0 : problems.some((p) => p.includes(expected));
    console.log(`${good ? 'ok  ' : 'FAIL'}  ${what}${good ? '' : `: got ${JSON.stringify(problems)}`}`);
    if (!good) failed += 1;
  }
  console.log(failed ? `self-test: ${failed} failed` : 'self-test: all cases behave');
  return failed ? 1 : 0;
}
