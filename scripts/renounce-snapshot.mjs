/**
 * The one block the checks before the renounce read the chain at, and the role replay on it.
 *
 * scripts/check-before-renounce.mjs reads the role holders (scripts/check-role-holders.mjs, a
 * separate process), the Safe's history and the timelock's queue. Read at different blocks, a
 * grant between two of the reads is in none of them, and the report describes no single moment.
 * So the gate picks one finalized block, hands it to the replay with its hash, and reads
 * everything else at it. A replay that finds another hash at that number is on another fork, or
 * a node that is not the one the gate read, and stops.
 *
 * Both functions are small on purpose: `node scripts/check-before-renounce.mjs --self-test` runs
 * them on a made-up provider and made-up logs.
 */

/**
 * The block to read at: AT_BLOCK when it is set (with its hash when that is set too), otherwise
 * the chain's finalized block. Throws with the reason when it cannot be had.
 */
export async function snapshotBlock(provider, atBlock, atHash) {
  if (atBlock === undefined || atBlock === null || atBlock === '') {
    const b = await provider.getBlock('finalized');
    if (!b) throw new Error('the RPC has no finalized block, which this check reads at');
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  }
  const n = Number(atBlock);
  if (!Number.isInteger(n) || n < 0) throw new Error(`AT_BLOCK is not a block number: ${atBlock}`);
  const b = await provider.getBlock(n);
  if (!b) throw new Error(`the RPC has no block ${n}`);
  if (atHash && b.hash.toLowerCase() !== String(atHash).toLowerCase()) {
    throw new Error(`block ${n} is ${b.hash} on this RPC, not ${atHash}: it is on another fork, or not the chain the gate read`);
  }
  return { number: b.number, hash: b.hash, timestamp: b.timestamp };
}

/**
 * Who holds each role after the RoleGranted and RoleRevoked logs up to and including `atBlock`, in
 * chain order. A log after the block is left out even if a provider returns it, so the holders are
 * the ones at the snapshot and not some later state.
 *
 * logs: [{ blockNumber, index, granted: bool, role, account }], in any order.
 * Returns Map role -> Set of lowercase accounts.
 */
export function holdersAt(logs, atBlock) {
  const members = new Map();
  const inOrder = logs
    .filter((l) => l.blockNumber <= atBlock)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const l of inOrder) {
    if (!members.has(l.role)) members.set(l.role, new Set());
    if (l.granted) members.get(l.role).add(l.account.toLowerCase());
    else members.get(l.role).delete(l.account.toLowerCase());
  }
  return members;
}
