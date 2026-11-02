/**
 * Everything a Safe has done since it was made, read from its own log, and what in it would let
 * someone act for the Safe that no getter shows. Used by scripts/check-before-renounce.mjs.
 *
 * Safe decides who may act from storage (its owners and modules), and getOwners and
 * getModulesPaginated list only the entries linked into their lists. Code that runs as the Safe,
 * by a DelegateCall from one of its transactions or by a module, can write around them, and
 * script/SplitAuthority.s.sol, which reads the contracts, cannot see that it ever happened. A
 * SafeL2 logs each transaction with its operation (SafeMultiSigTransaction) and each module call
 * (SafeModuleTransaction), so its log shows it. A Safe that is not SafeL2 logs neither, and is
 * refused.
 *
 * `assessSafeHistory` is pure, so `node scripts/check-before-renounce.mjs --self-test` runs it
 * on made-up logs.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

// The runtime each version's SafeProxyFactory deploys (the same hashes script/SplitAuthority.s.sol pins).
const SAFE_PROXY_CODE = new Set([
  '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000', // 1.3.0
  '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c', // 1.4.1
  '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f', // 1.5.0
]);
// SafeL2 at Safe's own addresses, with the code hash safe-global/safe-deployments lists.
const SAFE_L2 = new Map([
  ['0x3e5c63644e683549055b9be8653de26e0b4cd36e', { name: 'SafeL2 1.3.0', code: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f' }],
  ['0xfb1bffc9d739b8d520daf37df666da4c687191ea', { name: 'SafeL2 1.3.0', code: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f' }],
  ['0x29fcb43b46531bca003ddc8fcb67ffe91900c762', { name: 'SafeL2 1.4.1', code: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff' }],
  ['0xedd160febbd92e350d4d398fb636302fccd67c7e', { name: 'SafeL2 1.5.0', code: '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc' }],
]);
// The one DelegateCall target allowed: Safe's MultiSendCallOnly, which batches plain calls and refuses
// to DelegateCall itself. The Safe app sends a batch of calls through it.
export const MULTI_SEND_CALL_ONLY = new Map([
  ['0x40a2accbd92bca938b02010e17a5b8929b49130d', '0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad'], // 1.3.0
  ['0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b', '0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad'], // 1.3.0 eip155
  ['0x9641d764fc13c8b624c04430c7356c1c7c8102e2', '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939'], // 1.4.1
  ['0xa83c336b20401af773b6219ba5027174338d1836', '0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663'], // 1.5.0
]);

const SIGNATURES = {
  SafeSetup: 'SafeSetup(address,address[],uint256,address,address)',
  SafeMultiSigTransaction:
    'SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)',
  SafeModuleTransaction: 'SafeModuleTransaction(address,address,uint256,bytes,uint8)',
  ExecutionSuccess: 'ExecutionSuccess(bytes32,uint256)',
  ExecutionFailure: 'ExecutionFailure(bytes32,uint256)',
  ExecutionFromModuleSuccess: 'ExecutionFromModuleSuccess(address)',
  ExecutionFromModuleFailure: 'ExecutionFromModuleFailure(address)',
  ApproveHash: 'ApproveHash(bytes32,address)',
  EnabledModule: 'EnabledModule(address)',
  AddedOwner: 'AddedOwner(address)',
  RemovedOwner: 'RemovedOwner(address)',
  ChangedThreshold: 'ChangedThreshold(uint256)',
  ChangedMasterCopy: 'ChangedMasterCopy(address)',
};
const NAME_OF = new Map(Object.entries(SIGNATURES).map(([name, sig]) => [ethers.id(sig), name]));
const coder = ethers.AbiCoder.defaultAbiCoder();
// Safe versions index some of these and not others, so a single value is read from wherever it is.
const one = (log, type) => (log.topics.length > 1
  ? coder.decode([type], log.topics[1])[0]
  : coder.decode([type], log.data)[0]);

/** A raw log as { name, ...fields, txHash }, or null for an event this check does not use. */
export function decodeSafeLog(log) {
  const name = NAME_OF.get(log.topics[0]);
  if (!name) return null;
  const base = { name, txHash: log.transactionHash, block: log.blockNumber };
  switch (name) {
    case 'SafeSetup': {
      const [owners, threshold] = coder.decode(['address[]', 'uint256', 'address', 'address'], log.data);
      return { ...base, owners: owners.map((o) => o.toLowerCase()), threshold: Number(threshold) };
    }
    case 'SafeMultiSigTransaction': {
      const [to, , , operation] = coder.decode(
        ['address', 'uint256', 'bytes', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'bytes', 'bytes'],
        log.data,
      );
      return { ...base, to: to.toLowerCase(), operation: Number(operation) };
    }
    case 'SafeModuleTransaction': {
      const [module, to] = coder.decode(['address', 'address', 'uint256', 'bytes', 'uint8'], log.data);
      return { ...base, module: module.toLowerCase(), to: to.toLowerCase() };
    }
    case 'ExecutionSuccess':
    case 'ExecutionFailure':
      return { ...base, safeTxHash: one(log, 'bytes32') };
    case 'ApproveHash':
      return { ...base, safeTxHash: log.topics[1], owner: coder.decode(['address'], log.topics[2])[0].toLowerCase() };
    case 'ChangedThreshold':
      return { ...base, threshold: Number(one(log, 'uint256')) };
    default:
      return { ...base, address: one(log, 'address').toLowerCase() };
  }
}

/**
 * What in the Safe's history could let someone act for it that no getter shows, or that the log and
 * the Safe as it is now do not agree on. Pure.
 *
 * @param {{ entries: object[], nonce: number, owners: string[], threshold: number }} state
 *   entries from decodeSafeLog, oldest first, from the block the Safe was made in to the head the
 *   nonce, owners and threshold were read at
 * @returns {string[]} problems; none means the history reconciles
 */
export function assessSafeHistory({ entries, nonce, owners, threshold }) {
  const problems = [];
  const setups = entries.filter((e) => e.name === 'SafeSetup');
  if (setups.length !== 1) {
    problems.push(setups.length === 0
      ? 'no SafeSetup in the log read: SAFE_CREATION_BLOCK must be the block the Safe was made in, or earlier'
      : 'more than one SafeSetup in the log');
    return problems;
  }
  const setup = setups[0];
  const held = new Set(setup.owners);
  let needed = setup.threshold;
  let transactions = 0;
  const ran = new Set();
  const approvals = [];
  for (const e of entries) {
    switch (e.name) {
      case 'SafeMultiSigTransaction':
        transactions += 1;
        if (e.operation === 1 && !MULTI_SEND_CALL_ONLY.has(e.to)) {
          problems.push(`transaction ${transactions} (${e.txHash}) DelegateCalled ${e.to}, which ran as the Safe and could write owners or modules no getter lists`);
        } else if (e.operation !== 0 && e.operation !== 1) {
          problems.push(`transaction ${transactions} (${e.txHash}) has operation ${e.operation}`);
        }
        break;
      case 'SafeModuleTransaction':
        problems.push(`module ${e.module} acted for the Safe in ${e.txHash}`);
        break;
      case 'ExecutionFromModuleSuccess':
      case 'ExecutionFromModuleFailure':
        problems.push(`module ${e.address} acted for the Safe in ${e.txHash}`);
        break;
      case 'EnabledModule':
        problems.push(`module ${e.address} was enabled in ${e.txHash}`);
        break;
      case 'ChangedMasterCopy':
        // SafeToL2Setup does this once, while the Safe is being made. Any later change ran by DelegateCall.
        if (e.txHash !== setup.txHash) problems.push(`the Safe's implementation was changed to ${e.address} in ${e.txHash}, after it was made`);
        break;
      case 'AddedOwner':
        held.add(e.address);
        break;
      case 'RemovedOwner':
        held.delete(e.address);
        break;
      case 'ChangedThreshold':
        needed = e.threshold;
        break;
      case 'ExecutionSuccess':
      case 'ExecutionFailure':
        ran.add(e.safeTxHash);
        break;
      case 'ApproveHash':
        approvals.push(e);
        break;
      default:
        break;
    }
  }
  // A SafeL2 logs every transaction that took a nonce, so the two must agree.
  if (transactions !== nonce) problems.push(`the log shows ${transactions} transactions and the Safe's nonce is ${nonce}`);
  const fromLog = [...held].sort();
  const now = owners.map((o) => o.toLowerCase()).sort();
  if (fromLog.join() !== now.join()) problems.push(`the log gives owners [${fromLog.join(', ')}], the Safe answers [${now.join(', ')}]`);
  if (needed !== threshold) problems.push(`the log gives a threshold of ${needed}, the Safe answers ${threshold}`);
  // An owner's on-chain approval stands until the transaction runs, and counts as that owner's signature then.
  for (const a of approvals) {
    if (!ran.has(a.safeTxHash)) problems.push(`owner ${a.owner} approved Safe transaction ${a.safeTxHash} on chain (${a.txHash}) and it has not run`);
  }
  return problems;
}

/** Whether `safe` is a Safe proxy running SafeL2 at one of Safe's addresses, read at `blockTag`. */
export async function safeL2Of(provider, safe, blockTag) {
  const code = await provider.getCode(safe, blockTag);
  if (!SAFE_PROXY_CODE.has(ethers.keccak256(code))) return { ok: false, reason: 'SAFE is not a Safe proxy' };
  const slot0 = await provider.getStorage(safe, 0, blockTag);
  const implementation = ethers.getAddress('0x' + slot0.slice(26)).toLowerCase();
  const known = SAFE_L2.get(implementation);
  if (!known) {
    return { ok: false, reason: `the Safe runs ${implementation}, not a SafeL2: only a SafeL2's log records each transaction's operation` };
  }
  if (ethers.keccak256(await provider.getCode(implementation, blockTag)) !== known.code) {
    return { ok: false, reason: `${implementation} does not hold the code Safe lists for ${known.name}` };
  }
  return { ok: true, name: known.name };
}

/** The Safe's logs from `fromBlock` to `toBlock`, decoded, oldest first. Chunked and paced like check-role-holders. */
export async function readSafeHistory(provider, safe, fromBlock, toBlock, { range = 10000, paceMs = 500 } = {}) {
  const entries = [];
  for (let from = fromBlock; from <= toBlock; from += range) {
    const to = Math.min(from + range - 1, toBlock);
    const logs = await provider.getLogs({ address: safe, fromBlock: from, toBlock: to });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    for (const log of logs) {
      const entry = decodeSafeLog(log);
      if (entry) entries.push(entry);
    }
    if (to < toBlock) await new Promise((resolve) => setTimeout(resolve, paceMs));
  }
  return entries;
}
