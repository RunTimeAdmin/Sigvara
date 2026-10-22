'use strict';

const fs = require('fs');

// ethers accepts 64 hex characters with or without the 0x prefix, and a deployment that
// spells the key without it works today, so this must too.
const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The oracle's signing key, from the file named by ORACLE_PRIVATE_KEY_FILE or, failing
 * that, from ORACLE_PRIVATE_KEY. Returns '' when neither is set, so the caller keeps its
 * one "missing required env vars" message.
 *
 * Two reasons this exists instead of reading the variable where it is used.
 *
 * A file keeps the key out of the container's environment. An environment variable shows
 * in `docker inspect`, in /proc/<pid>/environ, and in every child process, and it is how
 * the key reached the process on the first two deployments. A compose secret mounts the
 * file read-only and nothing else sees it.
 *
 * A malformed key must not be echoed. ethers puts the whole value in the error it throws
 * for a bad key, node prints that and exits, and `restart: unless-stopped` repeats it, so
 * a typo or a leftover placeholder put the real key in the container log on every restart.
 * The check here fails first with a fixed message that never contains the value.
 *
 * `env` and `readFile` are parameters so a test can supply both.
 */
function readPrivateKey(env = process.env, readFile = fs.readFileSync) {
  const file = env.ORACLE_PRIVATE_KEY_FILE || '';
  const inline = env.ORACLE_PRIVATE_KEY || '';

  if (file && inline) {
    throw new Error('set ORACLE_PRIVATE_KEY_FILE or ORACLE_PRIVATE_KEY, not both');
  }

  let raw = inline;
  if (file) {
    try {
      raw = String(readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read ORACLE_PRIVATE_KEY_FILE ${file} (${err && err.code ? err.code : 'error'})`);
    }
  }

  const key = raw.trim();
  if (!key) return '';
  if (!KEY_RE.test(key)) {
    const where = file ? `the file ${file}` : 'ORACLE_PRIVATE_KEY';
    throw new Error(`${where} does not hold a private key: expected 64 hex characters, with or without a leading 0x (the value is not shown)`);
  }
  return key.startsWith('0x') ? key : `0x${key}`;
}

module.exports = { readPrivateKey };
