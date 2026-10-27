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
const http = require('node:http');
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

  /** A top-level setting the stub chain reads, such as explodeHealth. */
  set(key, value) {
    this.data[key] = value;
    this.flush();
  }

  /**
   * An agent for an epoch to score: registered, active, and listed by the registry. Returns
   * what addAgent does. Naming any agent switches the stub's epoch on (see stub-chain.js).
   */
  addRegisteredAgent(opts) {
    const agent = this.addAgent(opts);
    this.data.registered = [...(this.data.registered || []), agent.didHash];
    this.flush();
    return agent;
  }

  /** Set one entry of a per-agent map the stub reads, such as `canPropose` or `bonded`. */
  setFor(map, didHash, value) {
    this.data[map] = { ...(this.data[map] || {}), [didHash]: value };
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
    STUB_CALLS: path.join(dir, 'calls.jsonl'),
  };
}

// Files the oracle should find already in its directory, such as a saved state. Written before
// it starts.
function seedFiles(dir, files) {
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

// Every regular file in the directory, by name, for a test to inspect once the process is gone.
function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

// What the oracle asked the chain to do, from the stub's record: [{ name, args }, ...].
function readCalls(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// stdout and stderr go to one file, not to two pipes. A parent gets no order between two pipes: when the
// runner is busy it reads a later stdout line before an earlier stderr one, so a test that waited for
// "epoch done" and then looked for the error logged just before it could fail to find it. In a file the
// lines stay in the order they were written, and a read sees everything written so far. The file sits
// beside `dir`, not in it, because a test lists the files in the oracle's own directory.
function spawnOracle(dir, env) {
  const logFile = `${dir}.log`;
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    ['--require', path.join(__dirname, 'stub-chain.js'), path.join(ORACLE_DIR, 'index.js')],
    { cwd: dir, env, stdio: ['pipe', fd, fd] },
  );
  fs.closeSync(fd);
  const out = {
    code: null,
    kept: null,
    get log() { return this.kept ?? fs.readFileSync(logFile, 'utf8'); },
    // Keeps the text and removes the file, where the oracle's directory is removed.
    drop() { this.kept = this.log; fs.rmSync(logFile, { force: true }); },
  };
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
 * @param {object} [opts.files] files to put in its directory first, by name
 */
async function startOracle({ world, env = {}, files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  const worldFile = path.join(dir, 'world.json');
  world.file = worldFile;
  world.flush();
  seedFiles(dir, files);
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
    out.drop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`the oracle did not start (exit ${out.code}):\n${out.log}`);
  }

  // Every request carries its own forwarded-for address unless the test names a client. The
  // peer is loopback, so the oracle trusts the header, and each call gets a rate-limit bucket
  // of its own; naming a client puts several calls in one bucket on purpose.
  let hop = 0;
  async function call(method, urlPath, body, token, { client } = {}) {
    hop += 1;
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': client ?? `10.1.${(hop >> 8) & 255}.${hop & 255}`,
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

  // A request written by hand, for the cases an HTTP client will not send: a request target
  // that is not a path, or one with a doubled slash. Resolves to the status line, or to the
  // error code when the oracle drops the connection.
  function raw(requestLine) {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end(`${requestLine}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (d) => { data += d; });
      socket.on('close', () => resolve(data.split('\r\n')[0] || 'closed with no response'));
      socket.on('error', (err) => resolve(`error ${err.code}`));
    });
  }

  return {
    port,
    call,
    raw,
    logs: () => out.log,
    alive: () => out.code === null,
    // Writes the oracle attempted, in order. The settings it started the chain module with are
    // separate: chainInit().
    calls: () => readCalls(dir).filter((c) => c.name !== 'init'),
    chainInit: () => readCalls(dir).find((c) => c.name === 'init')?.args[0],
    files: () => snapshot(dir),
    /** Resolves once the log has matched `pattern`, or throws with the log after `ms`. */
    async waitForLog(pattern, ms = 15_000) {
      const deadline = Date.now() + ms;
      while (!pattern.test(out.log)) {
        if (Date.now() > deadline) throw new Error(`no log line matched ${pattern} in ${ms}ms:\n${out.log}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async stop() {
      child.kill();
      await exited;
      out.drop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Start the oracle and wait for it to exit on its own, for the startup guards that refuse to
 * run. Returns the exit code, everything it printed, and the files left in its directory.
 */
async function runToExit({ world, env = {}, files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  const worldFile = path.join(dir, 'world.json');
  world.file = worldFile;
  world.flush();
  seedFiles(dir, files);
  const port = await freePort();
  const { child, out, exited } = spawnOracle(dir, { ...baseEnv(dir, port, worldFile), ...env });
  const timer = setTimeout(() => child.kill(), 15_000);
  await exited;
  clearTimeout(timer);
  const left = snapshot(dir);
  out.drop();
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: out.code, log: out.log, files: left };
}

/**
 * A webhook that records what it is sent, for tests of the watcher. Answers 204 to anything.
 * Resolves to { url, received, close }; `received` is filled as requests arrive.
 */
function webhookSink() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/hook`,
      received,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/**
 * Run the real watcher.js as a child process. It signs nothing and needs no chain for a poll
 * that finds no divergence, so the only thing to supply is where to look and where to speak:
 * `CHECKER_URL` and `WEBHOOK_URL` in `env`. The first poll runs at once, which is all a test
 * needs; the interval is the minimum the watcher accepts.
 */
function startWatcher({ env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  const child = spawn(process.execPath, [path.join(ORACLE_DIR, 'watcher.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      RPC_URL: 'http://127.0.0.1:9',
      REPUTATION_ADDRESS: `0x${'33'.repeat(20)}`,
      POLL_SECONDS: '30',
      ...env,
    },
  });
  const out = { log: '', code: null };
  child.stdout.on('data', (d) => { out.log += d; });
  child.stderr.on('data', (d) => { out.log += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => { out.code = code; resolve(code); }));
  return {
    logs: () => out.log,
    async stop() {
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { World, startOracle, runToExit, startWatcher, webhookSink, wallet, ASSET };
