'use strict';

// End-to-end test support: run the real oracle (index.js) as a child process against a
// stubbed chain, and talk to it over HTTP.
//
// A child process rather than an in-process require, for two reasons. index.js starts a
// server and timers on load and exports nothing, so a test that loaded it would never exit.
// And it exercises the real process boundary: the startup guards, the environment, the
// exit code.
//
// Nothing here is shipped: .dockerignore excludes this directory and the deployment copies
// only top-level files.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');

const ORACLE_DIR = path.resolve(__dirname, '..');
const ASSET = '0x3600000000000000000000000000000000000000';
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO = ethers.ZeroAddress;

const wallet = () => ethers.Wallet.createRandom().address;

/**
 * The world the stubbed chain describes. Builders write through to the file the running
 * oracle reads, so a test can extend the world between requests.
 */
class World {
  constructor() {
    this.data = {
      nowSec: Math.floor(Date.now() / 1000),
      head: 1_000_000,
      receipts: {},
      agents: {},
      standing: {},
    };
    this.file = null;
    this.txCount = 0;
  }

  flush() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  /** A registered, active agent. Returns its didHash, addresses and registration age. */
  addAgent({ registeredDaysAgo = 400 } = {}) {
    const operator = wallet();
    const agentAddress = wallet();
    const didHash = ethers.id(`agent-${agentAddress}`);
    this.data.agents[didHash] = {
      operator,
      agentAddress,
      registeredAt: this.data.nowSec - registeredDaysAgo * 86_400,
      status: 0,
    };
    this.flush();
    return { didHash, operator, agentAddress };
  }

  /**
   * A mined, successful transaction carrying ERC-20 Transfer logs of the payment asset.
   * @param {Array<{from: string, to: string, value: bigint}>} transfers
   */
  addTx(transfers, { asset = ASSET } = {}) {
    const hash = ethers.id(`tx-${++this.txCount}-${Math.random()}`);
    this.data.receipts[hash] = {
      status: 1,
      blockNumber: this.data.head - 10,
      logs: transfers.map((t) => ({
        address: asset,
        topics: [TRANSFER, ethers.zeroPadValue(t.from, 32), ethers.zeroPadValue(t.to, 32)],
        data: ethers.toBeHex(t.value, 32),
      })),
    };
    this.flush();
    return hash;
  }

  /** Hard standing of a counterparty, as the registry would report it. */
  setStanding(address, score) {
    this.data.standing[address.toLowerCase()] = score;
    this.flush();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Built from nothing, not from process.env: a developer machine may hold real keys, and the
// child must not inherit them. cwd is a fresh directory too, so dotenv finds no .env file.
function baseEnv(dir, port, worldFile) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    RPC_URL: 'http://stub.invalid',
    ORACLE_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    IDENTITY_ADDRESS: `0x${'22'.repeat(20)}`,
    REPUTATION_ADDRESS: `0x${'33'.repeat(20)}`,
    HOST: '127.0.0.1',
    PORT: String(port),
    EPOCH_HOURS: '24',
    ORACLE_STATE_PATH: path.join(dir, 'state.json'),
    STUB_WORLD: worldFile,
  };
}

function spawnOracle(dir, env) {
  const child = spawn(
    process.execPath,
    ['--require', path.join(__dirname, 'stub-chain.js'), path.join(ORACLE_DIR, 'index.js')],
    { cwd: dir, env },
  );
  const out = { log: '', code: null };
  child.stdout.on('data', (d) => { out.log += d; });
  child.stderr.on('data', (d) => { out.log += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => { out.code = code; resolve(code); }));
  return { child, out, exited };
}

/**
 * Start the oracle and wait until it answers. Resolves once /health responds, or throws with
 * the oracle's own output if it exits first.
 *
 * @param {object} opts
 * @param {World}  opts.world
 * @param {object} [opts.env] overrides for the child's environment
 */
async function startOracle({ world, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  const worldFile = path.join(dir, 'world.json');
  world.file = worldFile;
  world.flush();
  const port = await freePort();
  const { child, out, exited } = spawnOracle(dir, { ...baseEnv(dir, port, worldFile), ...env });

  const deadline = Date.now() + 20_000;
  let up = false;
  while (!up && out.code === null && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      up = res.status > 0;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) {
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`the oracle did not start (exit ${out.code}):\n${out.log}`);
  }

  // Every request carries its own forwarded-for address. The peer is loopback, so the
  // oracle trusts the header, and each call gets a rate-limit bucket of its own.
  let hop = 0;
  async function call(method, urlPath, body, token) {
    hop += 1;
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': `10.1.${(hop >> 8) & 255}.${hop & 255}`,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  }

  return {
    port,
    call,
    logs: () => out.log,
    async stop() {
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Start the oracle and wait for it to exit on its own, for the startup guards that refuse to
 * run. Returns the exit code and everything it printed.
 */
async function runToExit({ world, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  const worldFile = path.join(dir, 'world.json');
  world.file = worldFile;
  world.flush();
  const port = await freePort();
  const { child, out, exited } = spawnOracle(dir, { ...baseEnv(dir, port, worldFile), ...env });
  const timer = setTimeout(() => child.kill(), 15_000);
  await exited;
  clearTimeout(timer);
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: out.code, log: out.log };
}

module.exports = { World, startOracle, runToExit, wallet, ASSET };
