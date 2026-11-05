'use strict';

// A build from a working tree copies whatever is in it unless this file says not to, and .gitignore does
// nothing for that. What git is told to keep out because it is a key or a state file, the image keeps out too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('oracle/.dockerignore keeps out every key and state pattern .gitignore names', () => {
  const ignored = new Set(lines(path.join(__dirname, '.dockerignore')));
  const secret = lines(path.join(__dirname, '..', '.gitignore')).filter((l) => /pem|\.key|keystore|mnemonic|oracle-state|^secrets\/$/.test(l));
  assert.ok(secret.length >= 6, `found ${secret.join(', ')}`);
  for (const pattern of secret) assert.ok(ignored.has(pattern), `.dockerignore does not name ${pattern}`);
});

test('oracle/.dockerignore does not keep out the code that shares a name with them', () => {
  const ignored = lines(path.join(__dirname, '.dockerignore'));
  assert.ok(ignored.includes('secrets/'), 'a directory pattern');
  assert.equal(ignored.includes('secrets*'), false, 'which leaves oracle/secrets.js in the image');
  assert.ok(fs.existsSync(path.join(__dirname, 'secrets.js')));
});
