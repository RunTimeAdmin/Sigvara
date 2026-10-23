'use strict';

// The state file as pieces of text instead of one string.
//
// persist() used to build the whole file with a single JSON.stringify and write that string. At 100,000
// payment events that is a 38 MB string, a second 38 MB buffer made from it for the write, and a process that
// peaked at 442 MB. At 200,000 events it peaked at 779 MB, which is over the 768 MB the mainnet compose file
// allows, so the first save past about 190,000 events would have been killed by the kernel.
//
// The pieces yielded here concatenate to exactly what JSON.stringify gives for the same object, byte for byte, but
// none is much larger than `pieceChars`, so the peak is the live state plus one piece: 178 MB and 284 MB for the
// same two sizes. Saving takes about as long as before, because the cost is the bytes written, not the string.

const DEFAULT_PIECE_CHARS = 1 << 20;

// Written one entry at a time. These are the sections that grow with the number of agents.
const KEYED = new Set(['attestations', 'flags', 'links', 'attestCooldowns', 'paymentEvents', 'divergences']);

// A top-level array is written in slices this long. usedPaymentTxs is one entry per credited payment, so it is the
// longest list in the file.
const SLICE = 4096;

/**
 * @param {object} state  in the order the keys should be written, as JSON.stringify would write them
 * @param {{ pieceChars?: number }} [options]
 * @returns {Generator<string>}
 */
function* stateChunks(state, { pieceChars = DEFAULT_PIECE_CHARS } = {}) {
  let piece = '{';
  const ready = [];
  const put = (text) => {
    piece += text;
    if (piece.length >= pieceChars) { ready.push(piece); piece = ''; }
  };
  function* drain() { while (ready.length) yield ready.shift(); }

  let first = true;
  for (const key of Object.keys(state)) {
    const value = state[key];
    // JSON.stringify leaves out a property whose value it cannot represent.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    put((first ? '' : ',') + JSON.stringify(key) + ':');
    first = false;

    if (KEYED.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      put('{');
      let firstEntry = true;
      for (const [k, v] of Object.entries(value)) {
        const text = JSON.stringify(v);
        if (text === undefined) continue;
        put((firstEntry ? '' : ',') + JSON.stringify(k) + ':' + text);
        firstEntry = false;
        yield* drain();
      }
      put('}');
    } else if (Array.isArray(value) && value.length > SLICE) {
      put('[');
      for (let i = 0; i < value.length; i += SLICE) {
        // The inside of the array's own brackets, so the pieces join with commas into one array.
        put((i ? ',' : '') + JSON.stringify(value.slice(i, i + SLICE)).slice(1, -1));
        yield* drain();
      }
      put(']');
    } else {
      put(JSON.stringify(value));
    }
    yield* drain();
  }
  put('}');
  if (piece) ready.push(piece);
  yield* drain();
}

module.exports = { stateChunks, DEFAULT_PIECE_CHARS };
