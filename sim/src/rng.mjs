// A small seeded generator (mulberry32), so the cast and every hour's plan come out the same each
// time for the same seed. Not for anything secret: keys come from the mnemonic, never from here.

export function rng(seed) {
  let a = hash32(String(seed));
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, to turn a seed string such as "plan:142" into a 32-bit start state.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
