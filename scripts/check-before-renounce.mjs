/**
 * The last check before the step that cannot be undone, and the one script/SplitAuthority.s.sol's
 * renounce phase will not run without (the owner's decision, 2026-11-02: a hard gate).
 *
 * The renounce phase reads the contracts as they are. Four things are only in the chain's history:
 *
 *   1. Who holds every role. AccessControl cannot list holders, so a grant nobody expected shows
 *      only in the events. scripts/check-role-holders.mjs replays them, with BEFORE_RENOUNCE=1.
 *   2. Everything the Safe has done since it was made (scripts/safe-history.mjs). Safe reads who may
 *      act from storage its getters list only in part, so a Safe that ever let other code run as
 *      itself, by DelegateCall or through a module, may have someone acting for it that no getter
 *      shows. The Safe must be a SafeL2, whose log records each transaction's operation.
 *   3. What the timelock has queued (scripts/timelock-operations.mjs). Anyone may execute a ready
 *      operation, so one scheduled before the renounce runs after it whether or not anyone
 *      remembered it, and it may grant a role or upgrade a registry. Every operation still Waiting
 *      or Ready fails the check unless its id is in REVIEWED_TIMELOCK_OPERATIONS.
 *   4. Every proxy the deployer created (scripts/deployer-created.mjs). One the artifact does not name is not in
 *      any phase, so the deployer keeps whatever it holds on it. Each fails the check unless its address is in
 *      REVIEWED_UNRECORDED_PROXIES, which says someone has decided what happens to it.
 *
 * All four are read at one finalized block (scripts/renounce-snapshot.mjs), handed to the role
 * replay with its hash, so the report describes one moment. Read at different blocks, a grant
 * between two of the reads would be in none of them.
 *
 * When all pass, it writes deployments/<chain>.renounce-check.json: the block, the Safe's nonce and the
 * deployer's, a hash of the deployment artifact, and the state of every operation the timelock has ever
 * had, with their digest. The renounce phase refuses a report that failed, is for another chain, Safe,
 * timelock, deployer or artifact, is over an hour old, or that the Safe or the deployer has made a
 * transaction since. It also reads every operation's state again just before it broadcasts, and
 * refuses if one has run: anyone may execute, and that moves no nonce. The block hash and the source
 * commit (with whether the checkout had uncommitted changes) are in the report for the record; the
 * renounce does not check them. A deployer with code, such as an EIP-7702 delegation, is refused: what
 * it does through that code moves no nonce. A run that fails removes the old report first.
 *
 *   SAFE=0x.. TIMELOCK=0x.. COMMITTEE=0x.. ORACLE=0x.. GUARDIAN=0x.. SAFE_CREATION_BLOCK=n \
 *     node scripts/check-before-renounce.mjs
 *   node scripts/check-before-renounce.mjs --self-test
 *
 * SAFE_CREATION_BLOCK is the block the Safe was made in (or any block before it). The timelock's log is
 * read from TIMELOCK_FROM_BLOCK, by default the artifact's deployBlock. AT_BLOCK picks the block to read
 * at, and must already be final; by default it is the finalized block. REVIEWED_TIMELOCK_OPERATIONS is a
 * comma-separated list of operation ids meant to run after the handover; the renounce phase needs the
 * same list. REVIEWED_UNRECORDED_PROXIES is a comma-separated list of proxies the deployer created that the artifact
 * does not name and someone has decided about; the renounce phase does not read it, because the deployer making
 * another would move the nonce in the report. CHAIN_ID (default 5042, mainnet) and RPC_URL pick the chain, for a rehearsal;
 * check-role-holders.mjs reads the same two. MAX_RANGE and PACE_MS work as they do there.
 */

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  assessSafeHistory, safeL2Of, readSafeHistory, implementationAt, implementationProblems, MULTI_SEND_CALL_ONLY,
} from './safe-history.mjs';
import { proxiesCreatedBy, assessUnrecordedProxies, reviewedProxiesFrom, recordedProxies } from './deployer-created.mjs';
import { snapshotBlock, holdersAt } from './renounce-snapshot.mjs';
import {
  checkTimelockQueue, operationsDigest, reviewedFrom, printQueue, describeCall, pendingForReport,
  operationsFromLogs, assessTimelockOperations, TIMELOCK_INTERFACE,
} from './timelock-operations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

const SCHEMA = 'sigvara/renounce-check/v2';

if (process.argv.includes('--self-test')) process.exit(await selfTest(process.argv.includes('--write-fixture')));

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
// The artifact's own bytes go into the report, so the renounce can tell it is reading the same addresses.
const artifactBytes = readFileSync(join(root, 'deployments', `${CHAIN_ID}.json`));
const artifact = JSON.parse(artifactBytes.toString('utf8'));
if (!ethers.isAddress(artifact.deployer)) stop(`deployments/${CHAIN_ID}.json has no deployer`);
const timelockFrom = process.env.TIMELOCK_FROM_BLOCK ? Number(process.env.TIMELOCK_FROM_BLOCK) : artifact.deployBlock;
if (!Number.isInteger(timelockFrom) || timelockFrom < 0) {
  stop(`set TIMELOCK_FROM_BLOCK to a block before the timelock was deployed (deployments/${CHAIN_ID}.json has no deployBlock)`);
}
const reviewed = reviewedFrom(process.env.REVIEWED_TIMELOCK_OPERATIONS);

// No cached answers: everything is read at one block, and it must be the real one.
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) stop(`${RPC} is not chain ${CHAIN_ID}`);
let snap;
try {
  snap = await snapshotBlock(provider, process.env.AT_BLOCK, '');
} catch (e) {
  stop(e.message);
}
if (process.env.AT_BLOCK) {
  const finalized = await provider.getBlock('finalized');
  if (!finalized) stop('the RPC has no finalized block, so it cannot show that AT_BLOCK is final');
  if (finalized.number < snap.number) stop(`block ${snap.number} is not final yet: wait, or leave AT_BLOCK unset`);
}
const at = snap.number;
console.log(`== 0. one block for every read below: ${at} (${snap.hash}) ==`);
// Calls made through code at the deployer's address move no nonce, and the renounce trusts that nonce.
if ((await provider.getCode(artifact.deployer, at)) !== '0x') {
  stop(`the deployer ${artifact.deployer} has code (an EIP-7702 delegation?), so its nonce does not show what it has done`);
}

console.log('== 1. role holders, from the grant history ==');
const roles = spawnSync(process.execPath, [join(root, 'scripts', 'check-role-holders.mjs')], {
  env: roleReplayEnv(process.env, CHAIN_ID, RPC, snap),
  stdio: 'inherit',
});
if (roles.status !== 0) stop('the role holders do not reconcile (above)');

console.log("== 2. the Safe's history, from its own log ==");
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
// SafeL2 at this block says nothing about what the log leaves out unless it was SafeL2 from the start.
const made = entries.find((e) => e.name === 'SafeSetup');
if (made) problems.push(...implementationProblems(await implementationAt(provider, SAFE, made.block), await implementationAt(provider, SAFE, at)));
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

console.log("== 3. the timelock's queue, from its own log ==");
let queue;
try {
  queue = await checkTimelockQueue(provider, TIMELOCK, timelockFrom, at, reviewed, { range: RANGE, paceMs: PACE_MS });
} catch (e) {
  stop(e.message);
}
printQueue(queue, timelockFrom, at);
for (const p of queue.problems) console.log(`FAIL  ${p}`);
if (queue.problems.length > 0) stop("the timelock's queue does not reconcile (above)");
for (const p of queue.pending) console.log(`ok    ${p.id} is ${p.state} and listed as reviewed`);
const ops = operationsDigest(queue.operations, queue.states);

console.log('== 4. proxies the deployer created ==');
const deployerNonce = await provider.getTransactionCount(artifact.deployer, at);
const reviewedProxies = reviewedProxiesFrom(process.env.REVIEWED_UNRECORDED_PROXIES);
const proxies = await proxiesCreatedBy(provider, artifact.deployer, deployerNonce, at, { paceMs: PACE_MS });
const created = assessUnrecordedProxies({ proxies, recorded: recordedProxies(artifact), reviewed: reviewedProxies });
for (const p of created.problems) console.log(`FAIL  ${p}`);
if (created.problems.length > 0) stop('a proxy the deployer created is not accounted for (above)');
console.log(`ok    ${deployerNonce} transactions by the deployer, ${proxies.length} proxies created, ${created.unrecorded.length} outside the artifact and listed as reviewed`);

// Every read above was at `at`; the chain must still have the same block there.
try {
  await snapshotBlock(provider, at, snap.hash);
} catch (e) {
  stop(e.message);
}

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
writeFileSync(REPORT, reportJson({
  chainId: CHAIN_ID, safe: SAFE, timelock: TIMELOCK, deployer: artifact.deployer, snap,
  safeNonce: nonce, deployerNonce, artifactBytes,
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  sourceDirty: dirty.status === 0 ? dirty.stdout.trim() !== '' : null,
  ops, reviewed, pending: queue.pending, reviewedProxies,
}));
console.log(`before the renounce: all checks passed at block ${at}. Wrote deployments/${CHAIN_ID}.renounce-check.json, good for an hour while neither the Safe nor the deployer makes a transaction and no timelock operation changes state.`);

/**
 * The environment the role replay runs in: the same chain and endpoint, the block every read is at, the holders
 * it checks, and nothing else. An operator's shell may hold DEPLOYER_PRIVATE_KEY, which the replay has no use for.
 */
function roleReplayEnv(env, chainId, rpc, snap) {
  const passed = {};
  for (const name of ['PATH', 'SYSTEMROOT', 'NODE_EXTRA_CA_CERTS', 'SAFE', 'TIMELOCK', 'COMMITTEE', 'ORACLE', 'GUARDIAN', 'MAX_RANGE', 'PACE_MS']) {
    if (env[name] !== undefined) passed[name] = env[name];
  }
  return {
    ...passed, BEFORE_RENOUNCE: '1', CHAIN_ID: String(chainId), RPC_URL: rpc,
    AT_BLOCK: String(snap.number), AT_BLOCK_HASH: snap.hash,
  };
}

/**
 * The report, as text. script/SplitAuthority.s.sol reads the schema, the addresses, the time, the nonces,
 * artifact_keccak, the timelock ids, states and digest, and the reviewed ids; the rest is for the people who
 * read it. test/fixtures/renounce-check-v2.json is one, and the Forge tests read it as the renounce does.
 */
function reportJson({ chainId, safe, timelock, deployer, snap, safeNonce, deployerNonce, artifactBytes, sourceCommit, sourceDirty, ops, reviewed, pending, reviewedProxies }) {
  return `${JSON.stringify({
    schema: SCHEMA,
    passed: true,
    chain_id: chainId,
    safe: ethers.getAddress(safe),
    timelock: ethers.getAddress(timelock),
    deployer: ethers.getAddress(deployer),
    checked_block: snap.number,
    checked_block_hash: snap.hash,
    checked_at: snap.timestamp,
    safe_nonce: safeNonce,
    deployer_nonce: deployerNonce,
    artifact_keccak: ethers.keccak256(artifactBytes),
    source_commit: sourceCommit,
    source_dirty: sourceDirty,
    timelock_operation_ids: ops.ids,
    timelock_operation_states: ops.states,
    timelock_operations_digest: ops.digest,
    reviewed_timelock_operations: reviewed.map((id) => id.toLowerCase()).sort(),
    timelock_pending: pendingForReport(pending),
    reviewed_unrecorded_proxies: reviewedProxies,
  }, null, 2)}\n`;
}

/**
 * The history rules, the queue rules and the snapshot on made-up logs: each way to fail, and what passes.
 * With --write-fixture it rewrites test/fixtures/renounce-check-v2.json instead of comparing with it.
 */
async function selfTest(writeFixture = false) {
  let failed = 0;
  const check = (what, good, detail = '') => {
    console.log(`${good ? 'ok  ' : 'FAIL'}  ${what}${good ? '' : `: ${detail}`}`);
    if (!good) failed += 1;
  };

  // --- the Safe's history ---
  const a = (n) => `0x${String(n).padStart(40, '0')}`;
  const OWNERS = [a(1), a(2), a(3)];
  const setup = { name: 'SafeSetup', txHash: '0xc0', owners: OWNERS, threshold: 2 };
  const tx = (operation, to = a(9), txHash = '0xt') => ({ name: 'SafeMultiSigTransaction', txHash, to, operation });
  const ran = (hash) => ({ name: 'ExecutionSuccess', txHash: '0xt', safeTxHash: hash });
  const MULTI = [...MULTI_SEND_CALL_ONLY.keys()][2];
  const base = { nonce: 2, owners: OWNERS, threshold: 2 };
  const safeCases = [
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
  for (const [what, entries, state, expected] of safeCases) {
    const found = assessSafeHistory({ entries, ...state });
    check(what, expected === null ? found.length === 0 : found.some((p) => p.includes(expected)), JSON.stringify(found));
  }

  // --- the implementation since creation (audit finding 4.1) ---
  const SAFE_L2_1_4_1 = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762';
  const PLAIN_1_4_1 = '0x41675c099f32341bf84bfc5382af534df5c7461a';
  const SAFE_L2_1_3_0 = '0x3e5c63644e683549055b9be8653de26e0b4cd36e';
  check('SafeL2 from creation to now passes', implementationProblems(SAFE_L2_1_4_1, SAFE_L2_1_4_1).length === 0);
  check('made on plain Safe and SafeL2 now is refused, whatever the log says',
    implementationProblems(PLAIN_1_4_1, SAFE_L2_1_4_1).some((p) => p.includes('not a SafeL2')), JSON.stringify(implementationProblems(PLAIN_1_4_1, SAFE_L2_1_4_1)));
  check('another SafeL2 now than at creation is refused',
    implementationProblems(SAFE_L2_1_4_1, SAFE_L2_1_3_0).some((p) => p.includes('runs')), JSON.stringify(implementationProblems(SAFE_L2_1_4_1, SAFE_L2_1_3_0)));
  const atBlocks = { getStorage: async (_safe, _slot, tag) => ethers.zeroPadValue(tag === 5 ? PLAIN_1_4_1 : SAFE_L2_1_4_1, 32) };
  check('slot 0 is read as an address, at the block asked for',
    (await implementationAt(atBlocks, a(1), 5)) === PLAIN_1_4_1 && (await implementationAt(atBlocks, a(1), 6)) === SAFE_L2_1_4_1);

  // --- what the deployer created ---
  const DEPLOYER = a(13);
  const madeAt = (n) => ethers.getCreateAddress({ from: DEPLOYER, nonce: n }).toLowerCase();
  const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd';
  // Nonce 0 sent no contract, 1 is a plain contract, 2 and 3 are proxies, and 4 a proxy with no implementation set.
  const createdChain = {
    getCode: async (addr) => ([madeAt(1), madeAt(2), madeAt(3), madeAt(4)].includes(addr.toLowerCase()) ? '0x60' : '0x'),
    getStorage: async (addr, slot) => {
      const isProxy = [madeAt(2), madeAt(3)].includes(addr.toLowerCase()) && slot === IMPLEMENTATION_SLOT;
      return ethers.zeroPadValue(isProxy ? a(99) : '0x00', 32);
    },
    call: async () => ethers.zeroPadValue('0x01', 32),
  };
  const found = await proxiesCreatedBy(createdChain, DEPLOYER, 5, 200, { paceMs: 0 });
  check('the proxies a deployer created are found from its nonce, and nothing else',
    found.map((p) => p.address).join() === [madeAt(2), madeAt(3)].join() && found[0].nonce === 2, JSON.stringify(found));
  check('asks what the deployer still holds on each', found[0].deployerHolds.join() === 'DEFAULT_ADMIN_ROLE,UPGRADER_ROLE', JSON.stringify(found[0]));
  const recorded = recordedProxies({ identity: madeAt(2), reputation: ethers.getAddress(madeAt(3)), epochFees: undefined });
  check('every proxy in the artifact passes', assessUnrecordedProxies({ proxies: found, recorded, reviewed: [] }).problems.length === 0);
  const oneOut = recordedProxies({ identity: madeAt(2) });
  const unrecorded = assessUnrecordedProxies({ proxies: found, recorded: oneOut, reviewed: [] });
  check('a proxy outside the artifact, such as an epochFees it leaves out, fails, and says what the deployer holds',
    unrecorded.problems.length === 1 && unrecorded.problems[0].includes(madeAt(3)) && unrecorded.problems[0].includes('UPGRADER_ROLE'), JSON.stringify(unrecorded));
  check('it passes once listed as reviewed',
    assessUnrecordedProxies({ proxies: found, recorded: oneOut, reviewed: [madeAt(3)] }).problems.length === 0);
  check('a reviewed address that is no unrecorded proxy of this deployer fails',
    assessUnrecordedProxies({ proxies: found, recorded: oneOut, reviewed: [madeAt(3), a(55)] }).problems.some((p) => p.includes(a(55))));
  check('reviewed addresses are read, lowercased and sorted', reviewedProxiesFrom(`${ethers.getAddress(madeAt(3))}, ${a(1)}`).join() === [a(1), madeAt(3)].sort().join());
  let notAnAddress = '';
  try { reviewedProxiesFrom('0x12'); } catch (e) { notAnAddress = e.message; }
  check('a reviewed entry that is not an address fails loudly', notAnAddress.includes('not an address'), notAnAddress);

  // --- the timelock's queue ---
  // The module's own interface, so these logs are the ones it decodes; checked against OpenZeppelin's source below.
  const tl = TIMELOCK_INTERFACE;
  const ozSource = join(root, 'lib', 'openzeppelin-contracts', 'contracts', 'governance', 'TimelockController.sol');
  if (existsSync(ozSource)) {
    const src = readFileSync(ozSource, 'utf8').replace(/\s+/g, ' ');
    for (const name of ['CallScheduled', 'CallExecuted', 'Cancelled', 'CallSalt']) {
      const declared = src.match(new RegExp(`event ${name} ?\\(([^)]*)\\)`));
      const types = declared ? declared[1].split(',').map((p) => p.trim().split(' ')[0]).join(',') : null;
      const ours = tl.getEvent(name).format('sighash');
      check(`the ${name} event this script decodes is the one OpenZeppelin's TimelockController declares`,
        types !== null && ours === `${name}(${types})`, `${ours} against ${types}`);
    }
  } else {
    console.log('note  lib/openzeppelin-contracts is not checked out, so the event signatures are not compared with its source');
  }
  const roleCalls = new ethers.Interface(['function grantRole(bytes32,address)', 'function upgradeToAndCall(address,bytes)']);
  const ZERO = ethers.ZeroHash;
  let blockNumber = 100;
  const log = (name, args) => ({ ...tl.encodeEventLog(name, args), blockNumber: blockNumber++, index: 0, transactionHash: '0xt' });
  const id = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const grant = roleCalls.encodeFunctionData('grantRole', [ethers.id('UPGRADER_ROLE'), a(66)]);
  const upgrade = roleCalls.encodeFunctionData('upgradeToAndCall', [a(77), '0x']);
  const scheduled = (n, data) => log('CallScheduled', [id(n), 0, a(42), 0, data, ZERO, 172800]);
  const executed = (n, data) => log('CallExecuted', [id(n), 0, a(42), 0, data]);
  const cancelled = (n) => log('Cancelled', [id(n)]);
  const st = (pairs) => new Map(pairs.map(([n, state]) => [id(n), { state, readyAt: state === 1 || state === 2 ? 1_900_000_000 : null }]));
  const queueCases = [
    ['a pending role grant nobody reviewed fails, and says which role to whom', [scheduled(1, grant)], st([[1, 1]]), [],
      `grantRole(UPGRADER_ROLE, ${a(66)})`],
    ['a pending upgrade nobody reviewed fails, and says to what code', [scheduled(2, upgrade)], st([[2, 2]]), [],
      `upgradeToAndCall(${a(77)}`],
    ['a pending operation listed as reviewed passes', [scheduled(2, upgrade)], st([[2, 2]]), [id(2)], null],
    ['executed and cancelled operations pass', [scheduled(3, grant), executed(3, grant), scheduled(4, upgrade), cancelled(4)],
      st([[3, 3], [4, 0]]), [], null],
    ['a reviewed id that already ran fails', [scheduled(3, grant), executed(3, grant)], st([[3, 3]]), [id(3)], 'not pending'],
    ['a reviewed id the timelock never scheduled fails', [], st([]), [id(9)], 'never scheduled'],
    ['a reviewed entry that is not an id fails', [], st([]), ['0x1234'], 'not an operation id'],
    ['unset on chain with no Cancelled in the log fails', [scheduled(5, grant)], st([[5, 0]]), [], 'no Cancelled'],
    ['done on chain with no CallExecuted in the log fails', [scheduled(6, grant)], st([[6, 3]]), [], 'no CallExecuted'],
  ];
  for (const [what, logs, states, rev, expected] of queueCases) {
    const operations = operationsFromLogs(logs);
    const { problems: found } = assessTimelockOperations({ operations, states, reviewed: rev });
    check(what, expected === null ? found.length === 0 : found.some((p) => p.includes(expected)), JSON.stringify(found));
  }
  // The same id scheduled again after a cancel: the report shows its calls once, not once per schedule.
  const again = assessTimelockOperations({
    operations: operationsFromLogs([scheduled(4, upgrade), cancelled(4), scheduled(4, upgrade)]), states: st([[4, 1]]), reviewed: [],
  });
  check('an operation scheduled again after a cancel lists each call once',
    again.pending.length === 1 && again.pending[0].calls.length === 1 && again.problems[0].split('upgradeToAndCall').length === 2,
    JSON.stringify(again.problems));
  // The digest is over the ids in sorted order, whatever order the log gave them in, and changes with any state.
  const opsLogs = [scheduled(8, grant), scheduled(7, upgrade)];
  const d1 = operationsDigest(operationsFromLogs(opsLogs), st([[7, 1], [8, 3]]));
  const d2 = operationsDigest(operationsFromLogs([...opsLogs].reverse()), st([[7, 1], [8, 3]]));
  const d3 = operationsDigest(operationsFromLogs(opsLogs), st([[7, 3], [8, 3]]));
  const expectedDigest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]', 'uint8[]'], [[id(7), id(8)], [1, 3]]));
  check('the digest is keccak256(abi.encode(sorted ids, states)), as the renounce phase computes it',
    d1.digest === expectedDigest && d2.digest === d1.digest, `${d1.digest} ${d2.digest} ${expectedDigest}`);
  check('an operation that runs after the report changes the digest', d3.digest !== d1.digest, d3.digest);

  // --- one block for every read ---
  const R = ethers.id('UPGRADER_ROLE');
  const roleLog = (block, granted, account) => ({ blockNumber: block, index: 0, granted, role: R, account });
  const later = holdersAt([roleLog(10, true, a(1)), roleLog(21, true, a(2))], 20);
  check('a grant after the snapshot block is not among the holders at it', [...later.get(R)].join() === a(1), [...later.get(R)].join());
  const revoked = holdersAt([roleLog(10, true, a(1)), roleLog(20, false, a(1)), roleLog(20, true, a(3))], 20);
  check('a grant and a revocation in the snapshot block itself count', [...revoked.get(R)].join() === a(3), [...revoked.get(R)].join());
  const blocks = { finalized: { number: 50, hash: '0xaa', timestamp: 1 }, 50: { number: 50, hash: '0xaa', timestamp: 1 } };
  const fake = (b) => ({ getBlock: async (tag) => b[tag] ?? null });
  const snapOk = await snapshotBlock(fake(blocks), undefined, undefined);
  check('with no AT_BLOCK the snapshot is the finalized block', snapOk.number === 50 && snapOk.hash === '0xaa', JSON.stringify(snapOk));
  const refused = async (p, text) => { try { await p; return false; } catch (e) { return e.message.includes(text); } };
  check('a block with another hash at that number is refused',
    await refused(snapshotBlock(fake(blocks), '50', '0xbb'), 'another fork'));
  check('an RPC with no finalized block is refused', await refused(snapshotBlock(fake({}), '', ''), 'no finalized block'));
  const env = roleReplayEnv({ PATH: 'x', AT_BLOCK: '1', SAFE: a(1), DEPLOYER_PRIVATE_KEY: 'the key', OTHER: 'y' }, 5042, 'https://rpc', { number: 77, hash: '0xcc' });
  check('the role replay is handed the gate\'s block and its hash, and nothing older',
    env.AT_BLOCK === '77' && env.AT_BLOCK_HASH === '0xcc' && env.BEFORE_RENOUNCE === '1' && env.CHAIN_ID === '5042' && env.PATH === 'x' && env.SAFE === a(1),
    JSON.stringify(env));
  check('the role replay is handed no key, and nothing it does not read',
    !('DEPLOYER_PRIVATE_KEY' in env) && !('OTHER' in env), JSON.stringify(Object.keys(env)));

  // --- the queue read from a provider, as the gate reads it ---
  const TL = a(42);
  const saltLog = { ...tl.encodeEventLog('CallSalt', [id(1), ethers.id('salt')]), blockNumber: 101, index: 1, transactionHash: '0xt' };
  const queueLogs = [scheduled(1, grant), saltLog];
  const stateOf = new Map([[id(1), 1]]);
  const reads = new ethers.Interface(['function getOperationState(bytes32) view returns (uint8)', 'function getTimestamp(bytes32) view returns (uint256)']);
  const chain = (codeBefore) => ({
    getCode: async (_addr, block) => (block === 99 ? codeBefore : '0x60'),
    getLogs: async ({ fromBlock, toBlock }) => queueLogs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    call: async (tx) => {
      const parsed = reads.parseTransaction({ data: tx.data });
      const value = parsed.name === 'getOperationState' ? stateOf.get(parsed.args[0].toLowerCase()) ?? 0 : 1_900_000_000;
      return reads.encodeFunctionResult(parsed.name, [value]);
    },
  });
  const read = await checkTimelockQueue(chain('0x'), TL, 100, 200, [], { range: 50, paceMs: 0 });
  check('a provider\'s pending grant is found, with its salt and when it is ready',
    read.pending.length === 1 && read.pending[0].salt === ethers.id('salt') && read.pending[0].readyAt === 1_900_000_000 &&
      read.problems.some((p) => p.includes('nobody listed it as reviewed')), JSON.stringify(read.problems));
  const listed = await checkTimelockQueue(chain('0x'), TL, 100, 200, [id(1)], { range: 50, paceMs: 0 });
  check('the same grant passes once listed as reviewed', listed.problems.length === 0, JSON.stringify(listed.problems));
  check('a start block the timelock already had code at is refused',
    await refused(checkTimelockQueue(chain('0x60'), TL, 100, 200, [], { range: 50, paceMs: 0 }), 'already had code'));

  // --- the report, as script/SplitAuthority.s.sol and test/SplitAuthority.t.sol read it ---
  const fixturePath = join(root, 'test', 'fixtures', 'renounce-check-v2.json');
  const fixtureOps = operationsDigest(operationsFromLogs([scheduled(7, upgrade), scheduled(8, grant)]), st([[7, 1], [8, 3]]));
  const fixture = reportJson({
    chainId: 7777010, safe: a(11), timelock: a(12), deployer: a(13),
    snap: { number: 123, hash: ethers.id('block 123'), timestamp: 1_800_000_000 },
    safeNonce: 3, deployerNonce: 7, artifactBytes: Buffer.from('{"deployer":"fixture"}\n'),
    sourceCommit: '0'.repeat(40), sourceDirty: false, ops: fixtureOps, reviewed: [id(7)],
    pending: [{ id: id(7), state: 'Waiting', readyAt: 1_800_172_800, salt: ethers.id('salt'), calls: operationsFromLogs([scheduled(7, upgrade)]).get(id(7)).calls }],
    reviewedProxies: [a(14)],
  });
  if (writeFixture) {
    writeFileSync(fixturePath, fixture);
    console.log(`wrote ${fixturePath}`);
  } else {
    let onDisk = null;
    try { onDisk = readFileSync(fixturePath, 'utf8'); } catch { /* checked below */ }
    check('the report is written exactly as test/fixtures/renounce-check-v2.json, which the Forge tests read',
      onDisk === fixture, 'run node scripts/check-before-renounce.mjs --self-test --write-fixture and review the diff');
  }

  console.log(failed ? `self-test: ${failed} failed` : 'self-test: all cases behave');
  return failed ? 1 : 0;
}
