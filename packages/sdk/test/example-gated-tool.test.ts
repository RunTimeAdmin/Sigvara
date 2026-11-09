import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, it, expect } from 'vitest';

/**
 * examples/mcp-gated-tool/server.mjs, driven over stdio as a host drives it.
 *
 * The gate is replaced before the example loads it, so no chain is read. Its admit spends the nonce first, as
 * SigvaraGate does, and the first admit then fails the way a timed-out chain read does, with the RPC URL and its
 * key in the message.
 */
const SERVER = resolve(__dirname, '../../../examples/mcp-gated-tool/server.mjs');
const KEY = 'k3y0f7h3pr0v1d3r';

const STUB = `
const Module = require('node:module');
class SigvaraGate {
  constructor() { this.audience = 'mcp://test'; this.spent = new Set(); this.n = 0; this.calls = 0; }
  challenge(did) {
    const t = Math.floor(Date.now() / 1000);
    return { payload: 'payload-' + (++this.n), nonce: 'n' + this.n, timestamp: t, expiresAt: t + 300 };
  }
  async admit(did, issued) {
    if (this.spent.has(issued.payload)) return { ok: false, reason: 'replayed', threshold: 35, did };
    this.spent.add(issued.payload);
    if (++this.calls === 1) {
      throw new Error('request timeout (request={ "url": "https://arc.example/v2/${KEY}" }, code=TIMEOUT)');
    }
    return { ok: true, score: 50, threshold: 35, did };
  }
}
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@sigvara/protocol-sdk') return { SigvaraGate };
  return load.call(this, request, ...rest);
};
`;

let dir: string | undefined;
let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  child?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  child = undefined;
  dir = undefined;
});

function start() {
  dir = mkdtempSync(join(tmpdir(), 'gated-tool-'));
  const stub = join(dir, 'stub.cjs');
  writeFileSync(stub, STUB);
  child = spawn(process.execPath, ['--require', stub, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  return async (name: string, args: Record<string, unknown>) => {
    child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const { value } = await lines.next();
    return JSON.parse(value as string);
  };
}

const DID = 'did:sigvara:5042002:0x0000000000000000000000000000000000000001';
const text = (res: any) => JSON.stringify(res);

describe('the example gated tool after a failed chain read', () => {
  it('asks for a fresh challenge instead of calling the next try a replay, and keeps the RPC key out', async () => {
    const call = start();
    const c = JSON.parse((await call('sigvara_challenge', { did: DID })).result.content[0].text);
    const search = { did: DID, challenge: c.challenge, signature: 'sig', query: 'q' };

    const failed = await call('restricted_search', search);
    expect(text(failed)).toMatch(/call sigvara_challenge again/i);
    expect(text(failed)).not.toContain(KEY);
    expect(text(failed)).not.toContain('https://');

    const retry = await call('restricted_search', search);
    expect(text(retry)).not.toContain('already been used');

    const fresh = JSON.parse((await call('sigvara_challenge', { did: DID })).result.content[0].text);
    const admitted = await call('restricted_search', { ...search, challenge: fresh.challenge });
    expect(JSON.parse(admitted.result.content[0].text).admitted).toBe(true);
  });
});
