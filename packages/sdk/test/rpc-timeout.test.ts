import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigvaraVerifier, DEFAULT_RPC_TIMEOUT_MS } from '../src/verifier';
import { SigvaraGate } from '../src/gate';

const ADDRESSES = {
  identity: '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
  reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
  staking: '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B',
};
const DID = 'did:sigvara:5042002:0x0000000000000000000000000000000000000001';

// ethers waits five minutes for an RPC that has gone quiet, so a gate whose node died held every admit
// that long. These read the timeout back from the provider, and then check it against a node that
// accepts the connection and never answers.

const timeoutOf = (v: SigvaraVerifier): number => (v as any).provider._getConnection().timeout;

describe('RPC timeout', () => {
  it('is 30 seconds unless the caller says otherwise', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(30_000);
    const v = new SigvaraVerifier({ rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002 });
    expect(timeoutOf(v)).toBe(30_000);
  });

  it('is the one the caller sets, on a verifier and through a gate', () => {
    const v = new SigvaraVerifier({ rpcUrl: 'http://unused', addresses: ADDRESSES, timeoutMs: 1234 });
    expect(timeoutOf(v)).toBe(1234);
    const gate = new SigvaraGate({
      rpcUrl: 'http://unused', addresses: ADDRESSES, threshold: 40, audience: 'https://x.example', timeoutMs: 4321,
    });
    expect(timeoutOf((gate as any).verifier)).toBe(4321);
  });

  it('must be a positive number', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(
        () => new SigvaraVerifier({ rpcUrl: 'http://unused', addresses: ADDRESSES, timeoutMs: bad }),
        String(bad),
      ).toThrow(/timeoutMs must be a positive number/);
    }
  });

  it('abandons a read that the node never answers', async () => {
    const server = http.createServer(() => { /* accepts the request and never replies */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const v = new SigvaraVerifier({ rpcUrl: `http://127.0.0.1:${port}`, addresses: ADDRESSES, timeoutMs: 300 });
      const started = Date.now();
      await expect(v.isActive(DID)).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('SigvaraVerifier: batches a node accepts', () => {
  it('keeps to 20 calls in a batch, however many reads are asked for at once', async () => {
    const batches: number[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        const calls = Array.isArray(j) ? j : [j];
        batches.push(calls.length);
        const answers = calls.map((c: { id: number; method: string }) => ({
          jsonrpc: '2.0',
          id: c.id,
          result: c.method === 'eth_chainId' ? '0x4cef52' : `0x${'0'.repeat(63)}1`,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(j) ? answers : answers[0]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as { port: number };
      const verifier = new SigvaraVerifier({
        rpcUrl: `http://127.0.0.1:${port}`,
        addresses: { identity: `0x${'11'.repeat(20)}`, reputation: `0x${'22'.repeat(20)}`, staking: `0x${'33'.repeat(20)}` },
        chainId: 5042002,
      });
      const did = `did:sigvara:5042002:0x${'44'.repeat(20)}`;
      await Promise.all(Array.from({ length: 50 }, () => verifier.hasMinimumStake(did)));
      expect(Math.max(...batches)).toBe(20);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('SigvaraVerifier: the chain the node serves', () => {
  it('is asked once before the first read, again after a failed ask, and a node on another chain is not read', async () => {
    const asked: string[] = [];
    // The node's answer to eth_chainId; null fails the ask.
    let serves: string | null = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        const answers = (Array.isArray(j) ? j : [j]).map((c: { id: number; method: string }) => {
          asked.push(c.method);
          if (c.method !== 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: `0x${'0'.repeat(63)}1` };
          return serves === null
            ? { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'busy' } }
            : { jsonrpc: '2.0', id: c.id, result: serves };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(j) ? answers : answers[0]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const v = new SigvaraVerifier({ rpcUrl, addresses: ADDRESSES, chainId: 5042002 });
      await expect(v.isActive(DID)).rejects.toThrow();
      serves = '0x4cef52';
      // Three waves of reads, as three trust checks make. Without staticNetwork ethers asked with each of them.
      for (let i = 0; i < 3; i++) await Promise.all([v.isActive(DID), v.hasMinimumStake(DID), v.getTotalScore(DID)]);
      expect(asked.filter((m) => m === 'eth_chainId')).toHaveLength(2);
      expect(asked.filter((m) => m === 'eth_call')).toHaveLength(9);

      asked.length = 0;
      serves = '0x1';
      const elsewhere = new SigvaraVerifier({ rpcUrl, addresses: ADDRESSES, chainId: 5042002 });
      await expect(elsewhere.isActive(DID)).rejects.toThrow(/serves chain 1, but chain 5042002 is configured/);
      await expect(elsewhere.getMinimumStake()).rejects.toThrow(/serves chain 1/);
      expect(asked).toEqual(['eth_chainId']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
