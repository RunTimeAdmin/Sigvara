'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPrivateKey } = require('./secrets');

// Anvil's first test key. Public and valueless.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const files = (map) => (file) => {
  if (!(file in map)) { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; }
  return map[file];
};

test('readPrivateKey: returns an empty string when no key is configured', () => {
  assert.equal(readPrivateKey({}, files({})), '');
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY: '', ORACLE_PRIVATE_KEY_FILE: '' }, files({})), '');
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY: '   ' }, files({})), '');
});

test('readPrivateKey: reads the environment variable', () => {
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY: KEY }, files({})), KEY);
});

test('readPrivateKey: accepts a key without the 0x prefix, as ethers does', () => {
  // A deployment that spells its key this way works today. Refusing it would turn a
  // working oracle into a crash loop on the next restart.
  const bare = KEY.slice(2);
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY: bare }, files({})), KEY);
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY_FILE: '/k' }, files({ '/k': `${bare}\n` })), KEY);
});

test('readPrivateKey: accepts every spelling ethers accepts for a wallet', () => {
  const { Wallet } = require('ethers');
  for (const spelling of [KEY, KEY.slice(2)]) {
    assert.equal(
      new Wallet(readPrivateKey({ ORACLE_PRIVATE_KEY: spelling }, files({}))).address,
      new Wallet(spelling).address,
    );
  }
});

test('readPrivateKey: reads a file and trims the newline an editor adds', () => {
  const read = files({ '/run/secrets/oracle_key': `${KEY}\n`, '/crlf': `${KEY}\r\n` });
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY_FILE: '/run/secrets/oracle_key' }, read), KEY);
  assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY_FILE: '/crlf' }, read), KEY);
});

test('readPrivateKey: refuses to choose between a file and a variable', () => {
  // Two sources can disagree, and the one that wins would be a guess about which key signs.
  assert.throws(
    () => readPrivateKey({ ORACLE_PRIVATE_KEY: KEY, ORACLE_PRIVATE_KEY_FILE: '/k' }, files({ '/k': KEY })),
    /not both/,
  );
});

test('readPrivateKey: an unreadable file names the path and the error code, nothing else', () => {
  assert.throws(
    () => readPrivateKey({ ORACLE_PRIVATE_KEY_FILE: '/missing' }, files({})),
    (err) => /\/missing/.test(err.message) && /ENOENT/.test(err.message),
  );
});

test('readPrivateKey: a malformed key is refused and never echoed', () => {
  // The case that mattered: ethers prints the whole value for a bad key, and a restart
  // loop then writes it to the log every time. Each of these is a plausible mistake.
  const secretish = 'deadbeef'.repeat(8);
  const bad = [
    `0x${secretish.slice(0, 63)}<`,          // a leftover placeholder character
    `0x${secretish.slice(0, 62)}`,           // one byte short
    `0x${secretish}00`,                      // one byte long
    secretish.slice(0, 62),                  // one byte short, no prefix
    `${secretish}00`,                        // one byte long, no prefix
    `0x${secretish.slice(0, 60)}zzzz`,       // not hex
  ];
  for (const value of bad) {
    for (const env of [{ ORACLE_PRIVATE_KEY: value }, { ORACLE_PRIVATE_KEY_FILE: '/k' }]) {
      const read = files({ '/k': value });
      assert.throws(
        () => readPrivateKey(env, read),
        (err) => {
          assert.match(err.message, /does not hold a private key/);
          assert.ok(!err.message.includes(secretish.slice(0, 12)), `the message leaked the value: ${err.message}`);
          return true;
        },
        value,
      );
    }
  }
});

test('readPrivateKey: reads a real file by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-secret-'));
  try {
    const file = path.join(dir, 'oracle_key');
    fs.writeFileSync(file, `${KEY}\n`, { mode: 0o400 });
    assert.equal(readPrivateKey({ ORACLE_PRIVATE_KEY_FILE: file }), KEY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
