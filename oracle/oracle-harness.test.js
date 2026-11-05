'use strict';

// The harness itself, where a mistake reads as an oracle that will not start.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { freePort, BAD_PORTS } = require('./test-support/oracle-harness');

test('every port on the list is one fetch refuses', async () => {
  for (const port of BAD_PORTS) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), (err) => err.cause?.message === 'bad port', String(port));
  }
});

test('a port next to one of them is not refused for that reason', async () => {
  await assert.rejects(fetch('http://127.0.0.1:10081/health'), (err) => err.cause?.message !== 'bad port');
});

test('a free port is never one of them: one drawn is given back and another drawn', async (t) => {
  const listen = net.Server.prototype.listen;
  let draws = 0;
  t.after(() => { net.Server.prototype.listen = listen; });
  net.Server.prototype.listen = function drawBadFirst(port, ...rest) {
    draws += 1;
    return listen.call(this, draws === 1 ? 10080 : port, ...rest);
  };
  const port = await freePort();
  assert.equal(draws, 2);
  assert.notEqual(port, 10080);
  assert.equal(BAD_PORTS.has(port), false);
});
