'use strict';

/**
 * The embeddable score badge.
 *
 * A badge is the only part of Sigvara most people will ever touch. It goes in an
 * agent's README or on its site, and whoever sees it has installed nothing, connected
 * no wallet and read no documentation. So it has to survive being the entire product
 * for that person: say what the number is, say what it is out of, and be clickable
 * through to the evidence behind it.
 *
 * Two rules follow from that and are worth stating because both are easy to lose:
 *
 *   1. An unscored agent must never render as 0. `getTotalScore` returns 0 both for an
 *      agent scored zero and for one that has never been finalized, and showing "0/100"
 *      for "we have not looked yet" is a false accusation rendered in red. The states
 *      are kept distinct here and `lastUpdated` is what separates them.
 *
 *   2. The badge reports the FINALIZED on-chain score, never the oracle's preview. The
 *      preview is what this operator would propose; the finalized number is what
 *      survived a challenge window. A badge is a trust claim shown to strangers, so it
 *      shows the one that is not this operator's opinion.
 */

/** Text is rendered in monospace so width can be computed rather than measured. */
const FONT = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const FONT_SIZE = 11;
const CHAR_W = FONT_SIZE * 0.6; // monospace advance width, exact for this family
const PAD = 8;
const HEIGHT = 20;

const LABEL = 'sigvara';

/** Slate, for every state that is not a number. Neutral on purpose: "unknown" is not "bad". */
const NEUTRAL = '#57534e';

const BANDS = [
  { min: 75, color: '#15803d' }, // green
  { min: 50, color: '#a16207' }, // amber
  { min: 25, color: '#c2410c' }, // orange
  { min: 0, color: '#b91c1c' },  // red
];

function colorForScore(score) {
  return BANDS.find((b) => score >= b.min).color;
}

/**
 * @param {object} state one of:
 *   { kind: 'scored', score }   finalized score on chain
 *   { kind: 'unscored' }        registered, never finalized
 *   { kind: 'unregistered' }    no identity at this address
 *   { kind: 'slashed' }         bond taken; the badge must say so
 *   { kind: 'unavailable' }     the chain could not be read
 */
function valueFor(state) {
  switch (state.kind) {
    case 'scored':       return { text: `${state.score} / 100`, color: colorForScore(state.score) };
    case 'unscored':     return { text: 'not yet scored', color: NEUTRAL };
    case 'unregistered': return { text: 'not registered', color: NEUTRAL };
    case 'slashed':      return { text: 'slashed', color: '#b91c1c' };
    default:             return { text: 'unavailable', color: NEUTRAL };
  }
}

/**
 * @dev Escapes the five XML entities. Nothing user-controlled reaches the text today,
 *      since every string above is a literal, but a badge is an SVG served to third
 *      party pages and that is not a place to rely on a caller staying disciplined.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function widthOf(text) {
  return Math.ceil(text.length * CHAR_W) + PAD * 2;
}

/**
 * Render the badge as a standalone SVG.
 *
 * Self-contained by necessity: no external stylesheet, no web font, no script. It is
 * loaded through an <img> tag on somebody else's page, where none of those would run.
 */
function renderBadge(state) {
  const value = valueFor(state);
  const labelW = widthOf(LABEL);
  const valueW = widthOf(value.text);
  const total = labelW + valueW;
  const alt = `${LABEL}: ${value.text}`;

  // Drawn with no element ids at all, which is not a style preference.
  //
  // The obvious way to round only the outer corners is a <clipPath> referenced by
  // url(#id). Inline two of those badges in one HTML document and the ids collide:
  // url(#r) resolves to the FIRST match in the document, so every badge after the first
  // is clipped to the first one's width and its text is sliced off mid-word. It renders
  // perfectly on its own and breaks the moment a page shows a list of agents, which is
  // the page this badge exists for.
  //
  // So: one full-width rounded rect in the value colour, with the label drawn over it as
  // a path rounded on its left side only. No ids, nothing document-scoped, safe to
  // inline any number of times.
  const r = 3;
  const labelPath = `M${r},0 H${labelW} V${HEIGHT} H${r} `
    + `A${r},${r} 0 0 1 0,${HEIGHT - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" `
    + `viewBox="0 0 ${total} ${HEIGHT}" role="img" aria-label="${esc(alt)}">`
    + `<title>${esc(alt)}</title>`
    + `<rect width="${total}" height="${HEIGHT}" rx="${r}" fill="${value.color}"/>`
    + `<path d="${labelPath}" fill="#1e1b34"/>`
    + `<g font-family="${FONT}" font-size="${FONT_SIZE}">`
    + `<text x="${labelW / 2}" y="14" text-anchor="middle" fill="#a5a1c4">${esc(LABEL)}</text>`
    + `<text x="${labelW + valueW / 2}" y="14" text-anchor="middle" fill="#fff">${esc(value.text)}</text>`
    + `</g></svg>`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * A badge on a popular agent's README is fetched once per reader, so the request rate
 * is set by that agent's audience rather than by anything this oracle controls. Without
 * a cache each of those becomes two RPC calls, and the epoch loop competes with readers
 * for the same node.
 *
 * Bounded as well as expiring: the key is an address supplied by whoever asks, so an
 * unbounded map is a memory exhaustion primitive available to anyone who can spell a
 * hex string. Eviction is oldest-first, which Map insertion order gives for free.
 */
function createBadgeCache({ ttlMs = 60_000, maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map();

  function get(key) {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  function set(key, value, ttl = ttlMs) {
    // Re-insert so a refreshed key moves to the back and is not the next evicted.
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttl });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return { get, set, size: () => entries.size };
}

/** `/badge/0xabc...def.svg`, case-insensitive. Returns the address, or null. */
const BADGE_PATH_RE = /^\/badge\/(0x[0-9a-fA-F]{40})\.svg$/;

function parseBadgePath(pathname) {
  const m = BADGE_PATH_RE.exec(pathname);
  return m ? m[1] : null;
}

module.exports = {
  renderBadge,
  valueFor,
  colorForScore,
  createBadgeCache,
  parseBadgePath,
  NEUTRAL,
};
