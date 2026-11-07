'use strict';

// The lobby on the Agents page (site/assets/lobby.js) is decoration on a reputation product, so these
// hold it to what it must not do: say anything about a score, pass a simulated agent off as anything
// else, or draw something the site's Content-Security-Policy refuses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lobby = require('../site/assets/lobby.js');

const OUTSIDE = '0x6bf992778c4405ffda4f998ee29ca08a591e7c87';
const SOLO = '0x9d7181c8676fd40e4b31510dc0e573a0c0c2fa11';
const KINDS = ['steady', 'mediocre', 'failing', 'ring', 'outside', 'demo', 'drill', 'own', 'something new'];
const MOODS = ['awake', 'asleep', 'ghost'];

test('a nickname comes from the address alone, in either spelling', () => {
  assert.equal(lobby.nickname(OUTSIDE), 'Tidal Yoyo');
  assert.equal(lobby.nickname(SOLO), 'Harbor Button');
  assert.equal(lobby.nickname('0x6BF992778C4405FFDA4F998EE29CA08A591E7C87'), 'Tidal Yoyo');
});

test('the nickname words are 64 each, so every six bits name a word, and none of them is a verdict', () => {
  for (const words of [lobby.ADJECTIVES, lobby.NOUNS]) {
    assert.equal(words.length, 64);
    assert.equal(new Set(words).size, 64);
  }
  const verdicts = /^(trusty|trusted|safe|honest|good|bad|best|worst|true|false|fake|scam|fraud|verified|reliable|golden|shady)$/i;
  assert.deepEqual([...lobby.ADJECTIVES, ...lobby.NOUNS].filter((w) => verdicts.test(w)), []);
});

test('nothing about a score can change the drawing', () => {
  const agent = { address: SOLO, kind: 'steady', simulated: true, mood: 'awake' };
  const plain = lobby.drawing(agent);
  assert.equal(lobby.drawing({ ...agent, total: 100, earned: 100, stake: 10n ** 24n }), plain);
  assert.equal(lobby.drawing({ ...agent, total: 0, earned: 0, stake: 0n }), plain);
});

test('a look follows the address, and a mood follows the status it is given', () => {
  const agent = { address: SOLO, kind: 'own', mood: 'awake' };
  assert.notEqual(lobby.drawing(agent), lobby.drawing({ ...agent, address: OUTSIDE }));
  assert.match(lobby.drawing({ ...agent, mood: 'asleep' }), />z</);
  const ghost = lobby.drawing({ ...agent, mood: 'ghost' });
  assert.match(ghost, /M23 27l6 6/);
  assert.doesNotMatch(lobby.drawing(agent), /M23 27l6 6/);
});

test('a simulated agent is marked as one in every mood, and only a simulated one', () => {
  for (const mood of MOODS) {
    assert.match(lobby.drawing({ address: SOLO, kind: 'steady', simulated: true, mood }), /stroke-dasharray/, mood);
    assert.doesNotMatch(lobby.drawing({ address: SOLO, kind: 'outside', simulated: false, mood }), /stroke-dasharray/, mood);
  }
});

test('every drawing is markup the site\'s Content-Security-Policy accepts', () => {
  for (const kind of KINDS) {
    for (const mood of MOODS) {
      const markup = lobby.svg({ address: OUTSIDE, kind, simulated: true, mood }, 30);
      assert.doesNotMatch(markup, /\sstyle=/, `${kind} ${mood}: a style attribute is refused`);
      assert.doesNotMatch(markup, /<style|<script|<image|\son[a-z]+=|href=/i, `${kind} ${mood}`);
    }
  }
});
