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
