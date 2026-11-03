'use strict';

// Links an ERC-8004 agent makes on chain, without asking an operator.
//
// POST /link needs a credential, and it writes only to the oracle it is sent to: a checker
// held no link unless someone sent the same call to it too, and then the two scored a linked
// agent differently. Instead, the owner of an ERC-8004 agent can name its Sigvara agent in the
// ERC-8004 Identity Registry, by setting the metadata key `sigvara` to the didHash (32 bytes).
// Only the 8004 agent's owner, or an address it approved, can set its metadata. Every operator
// reads the same MetadataSet logs, so the primary and the checker find the same links.
//
// This file is the arithmetic: what a log claims, how claims are kept, and which of them are
// worth checking at a snapshot. external.js reads the registry, and index.js runs the scan and
// checks each candidate against the registry as of the snapshot block.

const LINK_KEY = 'sigvara';

// Claims kept per Sigvara agent, oldest dropped first. Only its operator can add one (index.js
// checks at scan time), so the cap bounds the operator's own history, not anyone else's. Every
// claim is kept, a repeat of an earlier one included: an operator that scanned past a repeat
// must still find the earlier claim at a snapshot before it, as one that has not scanned it does.
const MAX_CLAIMS_PER_AGENT = 64;

const DID_HASH = /^0x[0-9a-f]{64}$/;

/**
 * What one MetadataSet log for LINK_KEY claims: { didHash, agentId, block, logIndex }, or null
 * when the value is not a 32-byte hash. A value of any other length, including the empty one
 * that clears the key, claims nothing.
 */
function claimFromLog({ agentId, value, blockNumber, logIndex }) {
  const didHash = String(value || '').toLowerCase();
  if (!DID_HASH.test(didHash)) return null;
  return { didHash, agentId: String(agentId), block: Number(blockNumber), logIndex: Number(logIndex) };
}

/**
 * Adds a claim to `claims` ({ didHash: [{ agentId, block, logIndex }] }, oldest first), in place.
 * Logs arrive in chain order, so the list stays sorted.
 */
function addClaim(claims, { didHash, agentId, block, logIndex }) {
  const list = claims[didHash] ?? [];
  list.push({ agentId, block, logIndex });
  claims[didHash] = list.slice(-MAX_CLAIMS_PER_AGENT);
  return claims;
}

/**
 * The 8004 agent ids that claimed `didHash`, by their newest claim, newest first. With `atBlock`,
 * only the claims made at or before it: a claim made after a snapshot does not apply to it, so
 * two operators that scanned to different heads still agree about the snapshot.
 */
function candidatesAt(claims, didHash, atBlock) {
  const list = claims?.[String(didHash).toLowerCase()] ?? [];
  const seen = new Set();
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (atBlock !== undefined && c.block > atBlock) continue;
    if (seen.has(c.agentId)) continue;
    seen.add(c.agentId);
    out.push(c.agentId);
  }
  return out;
}

/** Whether a log at (block, logIndex) comes before `cursor`, the first position not yet read. */
function isBefore({ blockNumber, logIndex }, cursor) {
  return blockNumber < cursor.block || (blockNumber === cursor.block && logIndex < cursor.logIndex);
}

/**
 * Whether a scan that started at `fromBlock` and stands at `cursor` (the first position not yet
 * read, null before its first log) has seen every claim made at or before `block`. Claims before
 * `fromBlock` are never read, so a block before it is covered from the start.
 */
function scanCovers(cursor, fromBlock, block) {
  return (cursor?.block ?? fromBlock) > block;
}

module.exports = { LINK_KEY, MAX_CLAIMS_PER_AGENT, claimFromLog, addClaim, candidatesAt, isBefore, scanCovers };
