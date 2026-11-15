'use strict';

// The state file as pieces of text instead of one string.
//
// persist() used to build the whole file with a single JSON.stringify and write that string. At 100,000
// payment events that is a 38 MB string, a second 38 MB buffer made from it for the write, and a process that
// peaked at 449 MB. At 200,000 events it peaked at 700 MB, close to the 768 MB the mainnet compose file
// allows, so a save past about 225,000 events would have been killed by the kernel.
//
// The pieces yielded here concatenate to exactly what JSON.stringify gives for the same object, byte for byte, but
// none is much larger than `pieceChars`, so the peak is the live state plus one piece: 189 MB and 280 MB for the
// same two sizes. Saving takes about as long as before, because the cost is the bytes written, not the string.

const DEFAULT_PIECE_CHARS = 1 << 20;

// Written one entry at a time. These are the sections that grow with the number of agents.
const KEYED = new Set(['attestations', 'flags', 'links', 'attestCooldowns', 'paymentEvents', 'divergences']);
// And these, whose growing map is one level down: funder-scan.js keeps { wallets: { <address>: ... } }.
const KEYED_WITHIN = new Map([['funderScanState', 'wallets']]);

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A top-level array is written in slices this long. usedPaymentTxs is one entry per credited payment, so it is the
// longest list in the file.
const SLICE = 4096;
// And an entry's list, such as one agent's payments, in slices this long. An agent's whole ledger was one string:
// 11 MB at the caps, and 151 MB when a payer padded its outcomes with the longest signatures it was allowed.
const ENTRY_SLICE = 256;

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
  // A map, one entry at a time, and a long list in an entry a slice at a time.
  function* entries(map) {
    put('{');
    let firstEntry = true;
    for (const [k, v] of Object.entries(map)) {
      if (Array.isArray(v) && v.length > ENTRY_SLICE) {
        put((firstEntry ? '' : ',') + JSON.stringify(k) + ':[');
        for (let i = 0; i < v.length; i += ENTRY_SLICE) {
          // The inside of the list's own brackets, so the slices join with commas into one list.
          put((i ? ',' : '') + JSON.stringify(v.slice(i, i + ENTRY_SLICE)).slice(1, -1));
          yield* drain();
        }
        put(']');
      } else {
        const text = JSON.stringify(v);
        if (text === undefined) continue;
        put((firstEntry ? '' : ',') + JSON.stringify(k) + ':' + text);
      }
      firstEntry = false;
      yield* drain();
    }
    put('}');
  }

  let first = true;
  for (const key of Object.keys(state)) {
    const value = state[key];
    // JSON.stringify leaves out a property whose value it cannot represent.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    put((first ? '' : ',') + JSON.stringify(key) + ':');
    first = false;

    if (KEYED.has(key) && isMap(value)) {
      yield* entries(value);
    } else if (KEYED_WITHIN.has(key) && isMap(value)) {
      put('{');
      let firstPart = true;
      for (const [k, v] of Object.entries(value)) {
        if (k === KEYED_WITHIN.get(key) && isMap(v)) {
          put((firstPart ? '' : ',') + JSON.stringify(k) + ':');
          yield* entries(v);
        } else {
          const text = JSON.stringify(v);
          if (text === undefined) continue;
          put((firstPart ? '' : ',') + JSON.stringify(k) + ':' + text);
        }
        firstPart = false;
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

// ---- Reading it back ---------------------------------------------------------------------------------------
//
// load() used to read the file into one string and parse it while the string was alive, so a load peaked at about
// 2.2 times the file: at the caps, 351 MB of the 432 MB heap V8 allows in the 768 MiB container, and a file of
// about 165 MB, or one where a payer padded its outcomes, ended the process inside JSON.parse. An out-of-memory
// abort is not an exception, so the .bak was never tried, and the restart policy started it into the same failure.
//
// parseJsonBuffer gives what JSON.parse gives for the file's text, but reads the file's bytes, which sit outside
// V8's heap, and turns only pieces of about `limit` bytes into strings at a time: a container larger than that is
// walked member by member, and runs of its small members are parsed together. Its peak is the parsed state plus one
// piece. The format is unchanged, so a build before this one reads what this one writes.

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_LIST = 0x5b;
const CLOSE_LIST = 0x5d;

const unexpected = (at) => new SyntaxError(`Unexpected token in JSON at position ${at}`);

function skipSpace(buf, i, end) {
  while (i < end && WHITESPACE.has(buf[i])) i += 1;
  return i;
}

// Where the string whose opening quote is at `i` ends, past its closing quote. No byte of a multi-byte UTF-8
// character is a quote or a backslash, so the bytes can be read one at a time.
function stringEnd(buf, i, end) {
  for (let j = i + 1; j < end; j += 1) {
    if (buf[j] === BACKSLASH) j += 1;
    else if (buf[j] === QUOTE) return j + 1;
  }
  throw unexpected(i);
}

// Where the value starting at `i` ends. Brackets are only counted here: the pieces that are parsed check their own
// syntax, and the containers that are walked check theirs as they are walked.
function valueEnd(buf, i, end) {
  const c = buf[i];
  if (c === QUOTE) return stringEnd(buf, i, end);
  if (c === OPEN_OBJECT || c === OPEN_LIST) {
    let depth = 0;
    for (let j = i; j < end; j += 1) {
      const b = buf[j];
      if (b === QUOTE) j = stringEnd(buf, j, end) - 1;
      else if (b === OPEN_OBJECT || b === OPEN_LIST) depth += 1;
      else if ((b === CLOSE_OBJECT || b === CLOSE_LIST) && --depth === 0) return j + 1;
    }
    throw unexpected(i);
  }
  let j = i;
  while (j < end && !WHITESPACE.has(buf[j]) && buf[j] !== COMMA && buf[j] !== CLOSE_OBJECT && buf[j] !== CLOSE_LIST) j += 1;
  if (j === i) throw unexpected(i);
  return j;
}

// The members of the container at [start, end): [keyStart, keyEnd, valueStart, valueEnd] for an object, and
// [valueStart, valueEnd] for a list.
function* membersOf(buf, start, end, keyed) {
  const close = end - 1;
  let i = skipSpace(buf, start + 1, close);
  if (i === close) return;
  for (;;) {
    let keyStart;
    let keyEnd;
    if (keyed) {
      if (buf[i] !== QUOTE) throw unexpected(i);
      keyStart = i;
      keyEnd = stringEnd(buf, i, close);
      i = skipSpace(buf, keyEnd, close);
      if (buf[i] !== COLON) throw unexpected(i);
      i = skipSpace(buf, i + 1, close);
    }
    if (i >= close) throw unexpected(i);
    const valueStop = valueEnd(buf, i, close);
    yield keyed ? [keyStart, keyEnd, i, valueStop] : [i, valueStop];
    i = skipSpace(buf, valueStop, close);
    if (i === close) return;
    if (buf[i] !== COMMA) throw unexpected(i);
    i = skipSpace(buf, i + 1, close);
  }
}

function parseRange(buf, start, end, limit) {
  if (end - start <= limit) return JSON.parse(buf.toString('utf8', start, end));
  const open = buf[start];
  if (open === OPEN_OBJECT && buf[end - 1] === CLOSE_OBJECT) {
    const out = {};
    for (const [ks, ke, vs, ve] of membersOf(buf, start, end, true)) {
      // An own property, as JSON.parse makes, even for a key named __proto__.
      Object.defineProperty(out, JSON.parse(buf.toString('utf8', ks, ke)), {
        value: parseRange(buf, vs, ve, limit), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }
  if (open === OPEN_LIST && buf[end - 1] === CLOSE_LIST) {
    const out = [];
    let runStart = -1;
    let runEnd = -1;
    const flush = () => {
      if (runStart < 0) return;
      for (const v of JSON.parse(`[${buf.toString('utf8', runStart, runEnd)}]`)) out.push(v);
      runStart = -1;
    };
    for (const [vs, ve] of membersOf(buf, start, end, false)) {
      if (ve - vs > limit) {
        flush();
        out.push(parseRange(buf, vs, ve, limit));
        continue;
      }
      if (runStart >= 0 && ve - runStart > limit) flush();
      if (runStart < 0) runStart = vs;
      runEnd = ve;
    }
    flush();
    return out;
  }
  // A container whose last byte does not close it is not JSON, and is refused without making a string of it.
  if (open === OPEN_OBJECT || open === OPEN_LIST) throw unexpected(end - 1);
  // A string, a number or a literal.
  return JSON.parse(buf.toString('utf8', start, end));
}

/**
 * JSON.parse for text held in a Buffer, without making one string of it.
 * @param {Buffer} buf
 * @param {{ limit?: number }} [options] the largest piece made into a string at once, in bytes
 */
function parseJsonBuffer(buf, { limit = DEFAULT_PIECE_CHARS } = {}) {
  const start = skipSpace(buf, 0, buf.length);
  let end = buf.length;
  while (end > start && WHITESPACE.has(buf[end - 1])) end -= 1;
  if (start === end) throw unexpected(0);
  return parseRange(buf, start, end, limit);
}

module.exports = { stateChunks, parseJsonBuffer, DEFAULT_PIECE_CHARS };
