// The runner against a stub chain and oracle: what it sends, and what it records, when a step after a
// send fails or the pause file appears part way through an hour. Each test runs `run.mjs tick` as the
// host would, so a second tick is a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { computeDidHash } from '@sigvara/protocol-sdk';
import { buildCast } from '../src/cast.mjs';
import { planHour, SLASHES } from '../src/plan.mjs';
import { rng } from '../src/rng.mjs';
import { walletAt } from '../src/wallets.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'run.mjs');
// The well-known test mnemonic, never used for anything real.
const PHRASE = 'test test test test test test test test test test test junk';
const SEED = 'run-test-seed';
const CHAIN_ID = 5042002;
const HEAD = 1000;
const cast = buildCast(rng(`${SEED}:cast`));
const staking = new ethers.Interface([
  'function getSlashProposal(bytes32) view returns (tuple(bytes32 didHash, address reporter, address victim, uint256 initiatedAt, uint8 state, bytes evidenceHash, uint256 challengeDeadline, uint256 disputedAt))',
]);
const GET_SLASH_PROPOSAL = staking.getFunction('getSlashProposal').selector;
const BALANCE_OF = ethers.id('balanceOf(address)').slice(0, 10);
const ringAgent = (s) => cast.agents.filter((a) => a.profile === 'ring')[SLASHES[s].ring].id;
const didOf = (id) => computeDidHash(walletAt(PHRASE, id).address, CHAIN_ID).toLowerCase();

/**
 * A JSON-RPC chain that accepts every transaction and mines it at once, and an oracle on the same port.
 * `slash` gives a proposal's state by didHash (a missing one fails the read); `attest` is 'ok' or 'down'.
 */
async function stub({ slash = {}, attest = 'ok', onSend = () => {} } = {}) {
  const sent = [];
  const block = {
    number: ethers.toQuantity(HEAD), hash: ethers.id('head'), parentHash: ethers.ZeroHash, timestamp: ethers.toQuantity(Math.floor(Date.now() / 1000)),
    nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x',
    baseFeePerGas: '0x1', transactions: [],
  };
  const answer = ({ method, params }) => {
    switch (method) {
      case 'eth_chainId': return ethers.toQuantity(CHAIN_ID);
      case 'eth_blockNumber': return ethers.toQuantity(HEAD);
      case 'eth_getBlockByNumber': return block;
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x1';
      case 'eth_getBalance': return ethers.toQuantity(ethers.parseEther('100'));
      case 'eth_getTransactionCount': return ethers.toQuantity(sent.length);
      case 'eth_estimateGas': return '0x30000';
      case 'eth_call': {
        const data = params[0].data;
        if (data.startsWith(BALANCE_OF)) return ethers.toBeHex(ethers.parseEther('1000000'), 32);
        if (data.startsWith(GET_SLASH_PROPOSAL)) {
          const did = '0x' + data.slice(10, 74);
          if (!(did in slash)) throw new Error('read refused');
          return staking.encodeFunctionResult('getSlashProposal', [[did, ethers.ZeroAddress, ethers.ZeroAddress, 1, slash[did], '0x', 2, 0]]);
        }
        throw new Error(`unexpected call ${data.slice(0, 10)}`);
      }
      case 'eth_sendRawTransaction': {
        const tx = ethers.Transaction.from(params[0]);
        sent.push(tx);
        onSend(tx);
        return tx.hash;
      }
      case 'eth_getTransactionReceipt': {
        const tx = sent.find((t) => t.hash === params[0]);
        return tx && {
          transactionHash: tx.hash, transactionIndex: '0x0', blockHash: ethers.id(`block of ${tx.hash}`), blockNumber: ethers.toQuantity(HEAD - 5),
          from: tx.from, to: tx.to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null,
          logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2',
        };
      }
      default: throw new Error(`unexpected method ${method}`);
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/attest')) {
        if (attest === 'down') { req.socket.destroy(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      const one = (r) => {
        try { return { jsonrpc: '2.0', id: r.id, result: answer(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: e.message } }; }
      };
      const q = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { sent, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A state file at hour `h` with every action up to it done, except those in `open`. */
function setup(h, open, manual = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sim-run-'));
  const done = {};
  for (let k = 0; k <= h; k++) for (const a of planHour(cast, SEED, k)) if (!open.includes(a.id)) done[a.id] = { at: 'before the test' };
  // Half an hour into hour h, so the hour does not roll over while the test runs.
  const start = Math.floor(Date.now() / 1000) - h * 3600 - 1800;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ seed: SEED, start, done, skipped: 0, manual }));
  writeFileSync(join(dir, 'mnemonic'), PHRASE);
  return dir;
}

function tick(dir, base) {
  const env = {
    ...process.env, SIM_SEED: SEED, SIM_MNEMONIC_FILE: join(dir, 'mnemonic'), SIM_STATE_FILE: join(dir, 'state.json'),
    SIM_RPC_URL: base, SIM_ORACLE_URL: base, SIM_PAUSE_FILE: join(dir, 'pause'), SIM_MANUAL_FILE: join(dir, 'manual.md'),
  };
  return new Promise((resolve) => execFile(process.execPath, [RUN, 'tick'], { cwd: dir, env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

/** The first hour after the day-0 agents bond with at least `n` payments, and its first `n` (posted ones first). */
function payHour(n) {
  for (let h = 25; ; h++) {
    const pays = planHour(cast, SEED, h).filter((a) => a.type === 'pay').sort((a, b) => Number(b.post) - Number(a.post));
    if (pays.length >= n && pays[0].post) return { h, pays: pays.slice(0, n) };
  }
}

test('a payment whose outcome cannot be posted is recorded, and a second tick in its hour does not pay again', async () => {
  const { h, pays: [pay] } = payHour(1);
  const chain = await stub({ attest: 'down' });
  try {
    const dir = setup(h, [pay.id]);
    await tick(dir, chain.base);
    await tick(dir, chain.base);
    assert.equal(chain.sent.length, 1, `${pay.id} was sent ${chain.sent.length} times`);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.done[pay.id]?.tx, chain.sent[0].hash);
  } finally {
    await chain.close();
  }
});

test('the pause file stops the rest of an hour, not only the next tick', async () => {
  const { h, pays } = payHour(2);
  let dir;
  const chain = await stub({ onSend: () => writeFileSync(join(dir, 'pause'), '') });
  try {
    dir = setup(h, pays.map((p) => p.id));
    const { stdout } = await tick(dir, chain.base);
    assert.ok(existsSync(join(dir, 'pause')));
    assert.equal(chain.sent.length, 1, `sent ${chain.sent.length} after the pause file appeared`);
    assert.match(stdout, /paused/);
  } finally {
    await chain.close();
  }
});

test('a slash found Disputed asks the admin to rule, even when the runner missed its own dispute', async () => {
  const [a0, a1] = [ringAgent(0), ringAgent(1)];
  const manual = {
    [a0]: { step: 'file-slash', did: didOf(a0), dispute: SLASHES[0].dispute },
    // The dispute was sent but its wait threw, so the step never moved on.
    [a1]: { step: 'file-slash', did: didOf(a1), dispute: SLASHES[1].dispute },
  };
  const chain = await stub({ slash: { [didOf(a0)]: 0, [didOf(a1)]: 4 } });
  try {
    const dir = setup(0, ['enforce:0'], manual);
    await tick(dir, chain.base);
    const text = readFileSync(join(dir, 'manual.md'), 'utf8');
    const addr = walletAt(PHRASE, a1).address;
    assert.match(text, new RegExp(`Rule on the disputed slash of ring agent ${addr}`));
    assert.doesNotMatch(text, new RegExp(`File the slash of ring agent ${addr}`));
  } finally {
    await chain.close();
  }
});

test('one slash that cannot be read does not stop the others', async () => {
  const [a0, a1] = [ringAgent(0), ringAgent(1)];
  const manual = {
    [a0]: { step: 'file-slash', did: didOf(a0), dispute: SLASHES[0].dispute },
    [a1]: { step: 'file-slash', did: didOf(a1), dispute: SLASHES[1].dispute },
  };
  // The first slash's read fails; the second is Disputed.
  const chain = await stub({ slash: { [didOf(a1)]: 4 } });
  try {
    const dir = setup(0, ['enforce:0'], manual);
    await tick(dir, chain.base);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.manual[a1].step, 'rule-dispute', `the second slash is at ${state.manual[a1].step}`);
    assert.match(readFileSync(join(dir, 'manual.md'), 'utf8'), /Rule on the disputed slash/);
  } finally {
    await chain.close();
  }
});
