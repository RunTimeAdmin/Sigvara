/**
 * Every operation the timelock has had scheduled, from its own log, and the state each is in at one
 * block. (An empty batch logs no call, and so is not here; it would run nothing.) Used by
 * scripts/check-before-renounce.mjs, and run alone by check_timelock_queue in scripts/check-mainnet.sh:
 *
 *   TIMELOCK=0x.. node scripts/timelock-operations.mjs
 *
 * A TimelockController cannot list its queue: an operation is a hash, and getOperationState answers
 * only for a hash you already have. Execution is open to anyone once the delay has run (EXECUTOR_ROLE
 * is held by the zero address), so an operation scheduled before the deployer renounces runs after it
 * whether or not anyone remembered it, and it may grant a role or upgrade a registry. The log is the
 * only place the queue shows: CallScheduled for each call, CallSalt for its salt, CallExecuted when
 * it runs, Cancelled when the Safe withdraws it. Each pending operation is printed and recorded with
 * every call's target, value, calldata and decoded arguments, its predecessor, delay and salt, and when
 * it becomes ready, so the people reviewing it read what will run and not only its id.
 *
 * An operation still Waiting or Ready fails the check unless its id is in REVIEWED_TIMELOCK_OPERATIONS
 * (comma-separated), which is how the people about to run the renounce say they have read it and mean
 * it to run. An id on that list that is not pending fails too, so a stale list cannot pass.
 *
 * TIMELOCK_FROM_BLOCK is where the log is read from (default: the artifact's deployBlock, which is
 * before phase 2 deploys the timelock). The check refuses a start the timelock already had code at,
 * since the log before it would be unread. AT_BLOCK (default: the finalized block), CHAIN_ID (default 5042),
 * RPC_URL, MAX_RANGE and PACE_MS work as they do in scripts/check-role-holders.mjs.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { snapshotBlock } from './renounce-snapshot.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

/** TimelockController.OperationState, in order. */
export const OPERATION_STATES = ['Unset', 'Waiting', 'Ready', 'Done'];
const WAITING = 1;
const READY = 2;
const DONE = 3;

const TIMELOCK_ABI = [
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  'event Cancelled(bytes32 indexed id)',
  'event CallSalt(bytes32 indexed id, bytes32 salt)',
  'function getOperationState(bytes32 id) view returns (uint8)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
];
const IFACE = new ethers.Interface(TIMELOCK_ABI);
/** The timelock's events and reads as this module decodes them; the self-test encodes its logs with it. */
export const TIMELOCK_INTERFACE = IFACE;
const TOPICS = ['CallScheduled', 'CallExecuted', 'Cancelled', 'CallSalt'].map((n) => IFACE.getEvent(n).topicHash);

// The calls an operation on these contracts is most likely to make, named so a report says what will run.
const KNOWN = new Map([
  'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'renounceRole(bytes32,address)',
  'upgradeToAndCall(address,bytes)', 'updateDelay(uint256)', 'pause()', 'unpause()',
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)', 'cancel(bytes32)',
].map((sig) => [ethers.id(sig).slice(0, 10), sig]));

const coder = ethers.AbiCoder.defaultAbiCoder();
const CALLS = new ethers.Interface([...KNOWN.values()].map((sig) => `function ${sig}`));
// The roles these contracts use, so a grant says which role and not a hash.
const ROLE_NAMES = new Map([
  'DEFAULT_ADMIN_ROLE', 'UPGRADER_ROLE', 'STAKING_CORE_ROLE', 'ORACLE_ROLE', 'SLASHING_COMMITTEE_ROLE', 'SLASHER_ROLE',
  'GUARDIAN_ROLE', 'PROPOSER_ROLE', 'CANCELLER_ROLE', 'EXECUTOR_ROLE',
].map((n) => [n === 'DEFAULT_ADMIN_ROLE' ? ethers.ZeroHash : ethers.id(n), n]));

/** The arguments of a call to a known function, as text, or null when the selector is not one of them. */
function decodedArgs(data) {
  let parsed;
  try { parsed = CALLS.parseTransaction({ data }); } catch { return null; }
  if (!parsed) return null;
  return parsed.args.map((a, i) => {
    const type = parsed.fragment.inputs[i].type;
    if (type === 'bytes32' && ROLE_NAMES.has(String(a).toLowerCase())) return ROLE_NAMES.get(String(a).toLowerCase());
    if (type === 'bytes') return `${(String(a).length - 2) / 2} bytes of calldata ${a}`;
    return String(a);
  }).join(', ');
}

/** One call of a scheduled operation, as a line a person can read: the function, its arguments, the target. */
export function describeCall(call) {
  const selector = (call.data || '0x').slice(0, 10).toLowerCase();
  const sig = KNOWN.get(selector);
  const args = sig ? decodedArgs(call.data) : null;
  const fn = sig ? `${sig.split('(')[0]}(${args ?? 'undecodable arguments'})` : `selector ${selector} with calldata ${call.data}`;
  return `${fn} on ${call.target}${BigInt(call.value || 0) > 0n ? ` with ${call.value} wei` : ''}`;
}

/** Every operation in the log, as Map id -> { id, calls: [...], executed, cancelled }. Pure. */
export function operationsFromLogs(logs) {
  const ops = new Map();
  const get = (id) => {
    if (!ops.has(id)) ops.set(id, { id, calls: [], executed: 0, cancelled: 0, salt: null });
    return ops.get(id);
  };
  for (const log of logs) {
    const ev = IFACE.parseLog(log);
    if (!ev) continue;
    const id = ev.args.id.toLowerCase();
    if (ev.name === 'CallScheduled') {
      get(id).calls.push({
        index: Number(ev.args.index), target: ev.args.target, value: ev.args.value.toString(), data: ev.args.data,
        predecessor: ev.args.predecessor, delay: Number(ev.args.delay), block: log.blockNumber, txHash: log.transactionHash,
      });
    } else if (ev.name === 'CallSalt') get(id).salt = ev.args.salt;
    else if (ev.name === 'CallExecuted') get(id).executed += 1;
    else get(id).cancelled += 1;
  }
  return ops;
}

/** The timelock's log from `fromBlock` to `toBlock`, chunked and paced for the public RPC. */
export async function readTimelockLogs(provider, timelock, fromBlock, toBlock, { range = 10000, paceMs = 500 } = {}) {
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += range) {
    const to = Math.min(from + range - 1, toBlock);
    logs.push(...await provider.getLogs({ address: timelock, fromBlock: from, toBlock: to, topics: [TOPICS] }));
    if (to < toBlock) await new Promise((r) => setTimeout(r, paceMs));
  }
  return logs.filter((l) => l.blockNumber <= toBlock)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}

/** The state of each id at `blockTag`, and when a pending one becomes ready: Map id -> { state, readyAt }. */
export async function readOperationStates(provider, timelock, ids, blockTag) {
  const tl = new ethers.Contract(timelock, TIMELOCK_ABI, provider);
  const out = new Map();
  for (const id of ids) {
    const state = Number(await tl.getOperationState(id, { blockTag }));
    const readyAt = state === WAITING || state === READY ? Number(await tl.getTimestamp(id, { blockTag })) : null;
    out.set(id, { state, readyAt });
  }
  return out;
}

/**
 * What in the queue stops the renounce. Pure, so the self-test can run it.
 *
 * operations: from operationsFromLogs. states: Map id -> { state, readyAt }. reviewed: ids the operator
 * listed. Returns { problems: [string], pending: [{ id, state, readyAt, calls }] }.
 */
export function assessTimelockOperations({ operations, states, reviewed = [] }) {
  const problems = [];
  const pending = [];
  const listed = new Set();
  for (const raw of reviewed) {
    const id = String(raw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) { problems.push(`REVIEWED_TIMELOCK_OPERATIONS has "${raw}", which is not an operation id`); continue; }
    listed.add(id);
  }
  for (const op of operations.values()) {
    const s = states.get(op.id);
    if (!s) { problems.push(`operation ${op.id} has no state read`); continue; }
    const what = op.calls.map(describeCall).join('; ') || 'no call in the log';
    if (s.state === WAITING || s.state === READY) {
      pending.push({ id: op.id, state: OPERATION_STATES[s.state], readyAt: s.readyAt, salt: op.salt, calls: op.calls });
      if (!listed.has(op.id)) {
        problems.push(`operation ${op.id} is ${OPERATION_STATES[s.state]} and nobody listed it as reviewed: ${what}. ` +
          'Have the Safe cancel it, or add its id to REVIEWED_TIMELOCK_OPERATIONS if it is meant to run after the handover');
      }
    } else if (s.state === 0 && op.cancelled === 0) {
      // The genuine TimelockController clears an operation only by cancelling it.
      problems.push(`operation ${op.id} is in the log but unset on chain, and the log has no Cancelled for it: ${what}`);
    } else if (s.state === DONE && op.executed === 0) {
      problems.push(`operation ${op.id} is done on chain, but the log has no CallExecuted for it: ${what}`);
    }
  }
  for (const id of listed) {
    if (!operations.has(id)) problems.push(`${id} is listed as reviewed but the timelock never scheduled it`);
    else {
      const s = states.get(id)?.state;
      if (s !== WAITING && s !== READY) {
        problems.push(`${id} is listed as reviewed but is ${OPERATION_STATES[s] ?? 'unknown'}, not pending: take it off the list`);
      }
    }
  }
  return { problems, pending };
}

/**
 * The ids in a fixed order and their states, and their digest: keccak256(abi.encode(bytes32[], uint8[])).
 * script/SplitAuthority.s.sol computes the same digest from the report and checks every state again
 * before it broadcasts.
 */
export function operationsDigest(operations, states) {
  const ids = [...operations.keys()].sort();
  const stateList = ids.map((id) => states.get(id).state);
  const digest = ethers.keccak256(coder.encode(['bytes32[]', 'uint8[]'], [ids, stateList]));
  return { ids, states: stateList, digest };
}

/** Reads the queue at `blockTag` and assesses it. Throws if `fromBlock` is not before the timelock existed. */
export async function checkTimelockQueue(provider, timelock, fromBlock, at, reviewed, opts) {
  if (fromBlock > 0 && (await provider.getCode(timelock, fromBlock - 1)) !== '0x') {
    throw new Error(`the timelock already had code at block ${fromBlock - 1}, so its log before ${fromBlock} would be unread: ` +
      'set the start to a block before it was deployed');
  }
  const logs = await readTimelockLogs(provider, timelock, fromBlock, at, opts);
  const operations = operationsFromLogs(logs);
  const states = await readOperationStates(provider, timelock, [...operations.keys()], at);
  return { operations, states, ...assessTimelockOperations({ operations, states, reviewed }) };
}

/** Comma-separated ids, as the environment gives them. */
export function reviewedFrom(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
  const RPC = process.env.RPC_URL || (CHAIN_ID === 5042 ? 'https://rpc.mainnet.arc.io' : null);
  const fail = (msg) => { console.log(`FAIL  ${msg}`); console.log('timelock queue: STOP'); process.exit(1); };
  if (!RPC) fail(`set RPC_URL for chain ${CHAIN_ID}`);
  const TIMELOCK = process.env.TIMELOCK;
  if (!TIMELOCK || !ethers.isAddress(TIMELOCK)) fail('TIMELOCK is not set to an address');
  const fromBlock = process.env.TIMELOCK_FROM_BLOCK
    ? Number(process.env.TIMELOCK_FROM_BLOCK)
    : JSON.parse(readFileSync(join(root, 'deployments', `${CHAIN_ID}.json`), 'utf8')).deployBlock;
  if (!Number.isInteger(fromBlock) || fromBlock < 0) {
    fail(`set TIMELOCK_FROM_BLOCK to a block before the timelock was deployed (deployments/${CHAIN_ID}.json has no deployBlock)`);
  }
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) fail(`${RPC} is not chain ${CHAIN_ID}`);
  let snap;
  try { snap = await snapshotBlock(provider, process.env.AT_BLOCK, process.env.AT_BLOCK_HASH); } catch (e) { fail(e.message); }
  let result;
  try {
    result = await checkTimelockQueue(provider, TIMELOCK, fromBlock, snap.number, reviewedFrom(process.env.REVIEWED_TIMELOCK_OPERATIONS), {
      range: Number(process.env.MAX_RANGE || 10000), paceMs: Number(process.env.PACE_MS || 500),
    });
  } catch (e) { fail(e.message); }
  printQueue(result, fromBlock, snap.number);
  if (result.problems.length > 0) {
    for (const p of result.problems) console.log(`FAIL  ${p}`);
    console.log('timelock queue: STOP, something above failed');
    process.exit(1);
  }
  console.log('timelock queue: all checks passed');
}

/** The inventory, one line per operation. */
export function printQueue({ operations, states, pending }, fromBlock, at) {
  console.log(`ok    ${operations.size} operation(s) scheduled on the timelock from block ${fromBlock} to ${at}`);
  for (const op of operations.values()) {
    const s = states.get(op.id);
    const ready = s?.readyAt ? `, ready at ${new Date(s.readyAt * 1000).toISOString()}` : '';
    console.log(`      ${op.id} ${OPERATION_STATES[s?.state] ?? '?'}${ready}`);
    for (const c of op.calls) {
      console.log(`        call ${c.index}: ${describeCall(c)}; predecessor ${c.predecessor}, delay ${c.delay}s`);
    }
    if (op.salt) console.log(`        salt ${op.salt}`);
  }
  if (pending.length === 0) console.log('ok    nothing is waiting to run');
}

/** Pending operations as the report records them: what each call does, and the operation's own terms. */
export function pendingForReport(pending) {
  return pending.map((p) => ({
    id: p.id, state: p.state, ready_at: p.readyAt, salt: p.salt,
    calls: p.calls.map((c) => ({
      what: describeCall(c), target: c.target, value: c.value, data: c.data, predecessor: c.predecessor, delay: c.delay,
    })),
  }));
}

// Run as a script, and not when imported. Compared by real path: node resolves a symlink or a junction in the
// module's own URL but not in argv, and a mismatch here would skip the check and exit 0.
const runAsScript = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (runAsScript) await main();
