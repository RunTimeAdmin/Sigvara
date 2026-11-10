'use strict';

// Who first funded a wallet, read from the native transfers into it (reviewers.js asks, through
// chain.firstFunder).
//
// This was a binary search for the first block where the wallet held FUNDING_FLOOR or had sent a
// transaction, which is right only if that stays true once it is. On Arc it need not: USDC is the gas
// token and moves by EIP-3009, which spends a balance without a nonce, so a wallet can be funded,
// emptied by a permit it signed, and funded again. The search could land on the second funding, and an
// early one from the scored agent's own side then hid behind a faucet's.
//
// So the transfers in are read instead, from block 0 to the block asked about, and the first one that
// reaches the floor by itself names the funder (the largest, where one block holds several). Every
// change to a native balance on Arc emits Transfer from 0xffff…fffe (docs/arc.md), so that is one log
// filter. At Arc's 10,000-block limit it is thousands of reads a wallet, so they are spread over epochs
// (readWanted), and how far each wallet has been read is kept in the state file. Until a wallet is read
// as far as it is asked about, funderOf answers UNREAD.
//
// The answer depends only on the chain up to the block asked about, so two operators that have both
// read that far agree, however much further either has read.

const { readSplitting } = require('./log-spans');

// Arc's limit for one eth_getLogs, measured 4 November 2026. A node that allows less refuses the span,
// and it is halved.
const SPAN_BLOCKS = 10_000;

const UNREAD = 'unread';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first transfer in `logs` that reaches `floor` by itself, the largest in its block. Null when none does. */
function firstFunding(logs, floor) {
  const ordered = [...logs].sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
  let best = null;
  for (const t of ordered) {
    if (best && t.blockNumber > best.blockNumber) break;
    if (t.value >= floor && (!best || t.value > best.value)) best = t;
  }
  return best;
}

/** A wallet's entry as kept, or null when it is not one this reader wrote. */
function usableEntry(e) {
  if (!e || typeof e !== 'object' || !Number.isInteger(e.through) || e.through < -1) return null;
  if (e.funder !== undefined && !(/^0x[0-9a-f]{40}$/.test(e.funder) && Number.isInteger(e.block) && e.block <= e.through)) return null;
  if (e.want !== undefined && !Number.isInteger(e.want)) return null;
  return e;
}

/**
 * A reader over one state, { wallets: { <address>: { through, funder?, block?, want? } } }: the last
 * block whose transfers in have been read (-1 before any), the first funding once found, and the
 * furthest block asked about and not yet read. Wallets are read in the order they were first asked about.
 *
 * `readIn(address, from, to)` answers the transfers into `address` in blocks [from, to] as
 * [{ from, value, blockNumber, logIndex }], `from` lowercased and `value` a BigInt, and throws when the
 * node cannot answer. `floor` is reviewers.FUNDING_FLOOR.
 */
function createFunderReader({ readIn, floor, wait = sleep }) {
  let state = { wallets: {} };

  /** { funder, block } for `address` by block `cap`, null when nothing in by then names one, or UNREAD. */
  function answer(address, cap) {
    const e = state.wallets[String(address).toLowerCase()];
    if (e?.funder !== undefined) return e.block <= cap ? { funder: e.funder, block: e.block } : null;
    return e && e.through >= cap ? null : UNREAD;
  }

  /**
   * Who first funded `address` by block `cap`, as answer() says. Asked about a block not read yet, it
   * notes the wallet for readWanted and answers UNREAD. It never reads, so asking costs nothing.
   */
  async function funderOf(address, cap) {
    const found = answer(address, cap);
    if (found !== UNREAD) return found;
    const key = String(address).toLowerCase();
    // In place: readWanted may hold this entry while it reads.
    const e = state.wallets[key] ?? (state.wallets[key] = { through: -1 });
    e.want = Math.max(e.want ?? -1, cap);
    return UNREAD;
  }

  /**
   * Reads the wallets asked about, oldest ask first, a span at a time, until each is read as far as asked
   * or its funding is found, or `maxReads` reads have been made, or this host's clock passes `deadline`.
   * `paceMs` between reads. A read that fails stops it, keeping what was read before. Returns
   * { reads, left, error }: the reads made, the wallets still to read, and the failure if there was one.
   */
  async function readWanted({ maxReads = Infinity, deadline = Infinity, paceMs = 0 } = {}) {
    let reads = 0;
    const left = () => Object.values(state.wallets).filter((e) => e.want !== undefined).length;
    try {
      for (const [address, e] of Object.entries(state.wallets)) {
        while (e.want !== undefined && e.funder === undefined && e.through < e.want) {
          if (reads >= maxReads || Date.now() >= deadline) return { reads, left: left(), error: null };
          const from = e.through + 1;
          const to = Math.min(e.want, from + SPAN_BLOCKS - 1);
          const logs = await readSplitting(async (a, b) => {
            if (reads > 0 && paceMs) await wait(paceMs);
            reads += 1;
            return readIn(address, a, b);
          }, from, to);
          // The funding before the cursor, and the cursor only once its read is in, so a save made at any
          // point never says a block was read that was not.
          const first = firstFunding(logs, floor);
          if (first) Object.assign(e, { funder: first.from, block: first.blockNumber });
          e.through = to;
        }
        delete e.want;
      }
    } catch (error) {
      return { reads, left: left(), error };
    }
    return { reads, left: left(), error: null };
  }

  /** The state, to keep in the state file. The live object, so a save at any time holds what was read. */
  function getState() { return state; }

  /** Takes up a kept state. An entry this reader did not write is dropped, and that wallet is read again. */
  function restore(kept) {
    const wallets = {};
    for (const [address, e] of Object.entries(kept?.wallets ?? {})) {
      if (/^0x[0-9a-f]{40}$/.test(address) && usableEntry(e)) wallets[address] = e;
    }
    state = { wallets };
  }

  return { funderOf, readWanted, getState, restore };
}

module.exports = { createFunderReader, firstFunding, UNREAD, SPAN_BLOCKS };
