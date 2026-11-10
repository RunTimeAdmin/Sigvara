'use strict';

// The agents an epoch leaves out of its reads because they hold no bond: below the minimum stake, which is where every
// registration starts (PendingBond). Registering costs only gas, so each one used to be read four times an epoch, two
// before the batch and two guarding the write, to be skipped as unbonded.
//
// One is let back, and read at the next epoch like any other agent, when a log says its bond may have changed: a stake
// deposited, a withdrawal, a slash or a status change naming it, and every one when the minimum stake changes. The logs
// are read from where the last epoch's stopped, a little before it in case the node that answered the reads was behind
// the one that gave the head. Every agent is read on the first epoch, once a day after that, and whenever the logs or
// the head cannot be read, so a change no log showed waits a day at most. In memory only: a restart reads every agent.
//
// No dependencies, so it can be tested on its own.

const SWEEP_MS = 24 * 3_600_000;
const OVERLAP_BLOCKS = 100;

function createBondWatch({ sweepMs = SWEEP_MS, overlapBlocks = OVERLAP_BLOCKS } = {}) {
  const unbonded = new Set();
  // The head the logs were last read up to, and when every agent was last read.
  let cursor = null;
  let sweptAtMs = null;
  const key = (didHash) => String(didHash).toLowerCase();

  return {
    /** Whether the epoch leaves this agent out of its reads. */
    excluded: (didHash) => unbonded.has(key(didHash)),
    /** An agent an epoch's read found below the minimum stake. */
    add(didHash) { unbonded.add(key(didHash)); },
    size: () => unbonded.size,

    /**
     * Before an epoch reads anything. `readHead()` is the chain's block number, `readChanges(from, to)` resolves to
     * { agents: Set of lowercased didHashes, minimumChanged }. Resolves to { full } when every agent is read this
     * epoch, with `error` when that is because a read failed.
     */
    async refresh({ readHead, readChanges, nowMs }) {
      let head;
      try {
        head = await readHead();
      } catch (error) {
        unbonded.clear();
        cursor = null;
        return { full: true, error };
      }
      if (cursor === null || nowMs - sweptAtMs >= sweepMs) {
        unbonded.clear();
        cursor = head;
        sweptAtMs = nowMs;
        return { full: true };
      }
      const from = Math.max(0, cursor - overlapBlocks + 1);
      cursor = Math.max(cursor, head);
      if (head < from) return { full: false };
      try {
        const changes = await readChanges(from, head);
        if (changes.minimumChanged) {
          unbonded.clear();
          return { full: true };
        }
        for (const didHash of changes.agents) unbonded.delete(key(didHash));
        return { full: false };
      } catch (error) {
        unbonded.clear();
        return { full: true, error };
      }
    },
  };
}

module.exports = { createBondWatch, SWEEP_MS, OVERLAP_BLOCKS };
