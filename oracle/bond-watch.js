'use strict';

// The agents an epoch leaves out of its reads because they hold no bond: below the minimum stake, which is where every
// registration starts (PendingBond). Registering costs only gas, so each one used to be read four times an epoch, two
// before the batch and two guarding the write, to be skipped as unbonded.
//
// One is let back, and read at the next epoch like any other agent, when a log says its bond may have changed: a stake
// deposited, a withdrawal, a slash or a status change naming it, and every one when the minimum stake changes. The logs
// are read from where the last epoch's stopped, a little before it in case the node that answered the reads was behind
// the one that gave the head. Every agent is read on the first epoch and whenever the logs or the head cannot be read.
// After that each one is read again within a day of the epoch that found it unbonded, so a change no log showed waits a
// day at most. In memory only: a restart reads every agent.
//
// Those reads are spread over the day's epochs, a share each, the agents found longest ago first. They used to come all
// at once: every agent read in one epoch, about 0.47 s each, which at 10,000 registrations (about 50 USDC of gas on Arc
// mainnet) is 78 minutes (performance review, 15 November).
//
// No dependencies, so it can be tested on its own.

const SWEEP_MS = 24 * 3_600_000;
const OVERLAP_BLOCKS = 100;

function createBondWatch({ sweepMs = SWEEP_MS, overlapBlocks = OVERLAP_BLOCKS } = {}) {
  // Each agent left out, with the time of the epoch that found it unbonded, the earliest first.
  const unbonded = new Map();
  // The head the logs were last read up to.
  let cursor = null;
  // When the last epoch began, and how many agents are owed a read so far: the unbonded share of the time since,
  // carried over in fractions, so a few agents are not read every epoch for being rounded up.
  let refreshedAtMs = null;
  let owed = 0;
  const key = (didHash) => String(didHash).toLowerCase();

  function letEveryoneBack() {
    unbonded.clear();
    owed = 0;
  }

  // The share of the agents left out that the time since the last epoch is owed, and any found a day ago or more.
  function letDueBack(nowMs, elapsedMs) {
    owed += (unbonded.size * Math.max(0, elapsedMs)) / sweepMs;
    for (const [didHash, foundAtMs] of unbonded) {
      if (owed >= 1) owed -= 1;
      else if (nowMs - foundAtMs < sweepMs) break;
      unbonded.delete(didHash);
    }
    if (unbonded.size === 0) owed = 0;
  }

  return {
    /** Whether the epoch leaves this agent out of its reads. */
    excluded: (didHash) => unbonded.has(key(didHash)),
    /** An agent an epoch's read found below the minimum stake, dated by that epoch. */
    add(didHash) {
      unbonded.delete(key(didHash));
      unbonded.set(key(didHash), refreshedAtMs ?? 0);
    },
    size: () => unbonded.size,

    /**
     * Before an epoch reads anything. `readHead()` is the chain's block number, `readChanges(from, to)` resolves to
     * { agents: Set of lowercased didHashes, minimumChanged }. Resolves to { full } when every agent is read this
     * epoch, with `error` when that is because a read failed.
     */
    async refresh({ readHead, readChanges, nowMs }) {
      const elapsedMs = refreshedAtMs === null ? 0 : nowMs - refreshedAtMs;
      refreshedAtMs = nowMs;
      let head;
      try {
        head = await readHead();
      } catch (error) {
        letEveryoneBack();
        cursor = null;
        return { full: true, error };
      }
      if (cursor === null) {
        letEveryoneBack();
        cursor = head;
        return { full: true };
      }
      letDueBack(nowMs, elapsedMs);
      const from = Math.max(0, cursor - overlapBlocks + 1);
      cursor = Math.max(cursor, head);
      if (head < from) return { full: false };
      try {
        const changes = await readChanges(from, head);
        if (changes.minimumChanged) {
          letEveryoneBack();
          return { full: true };
        }
        for (const didHash of changes.agents) unbonded.delete(key(didHash));
        return { full: false };
      } catch (error) {
        letEveryoneBack();
        return { full: true, error };
      }
    },
  };
}

module.exports = { createBondWatch, SWEEP_MS, OVERLAP_BLOCKS };
