import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethers } from 'ethers';
import { createTrustServer, ARC_TESTNET } from '../src/mcp';
import { SigvaraVerifier, MULTICALL3 } from '../src/verifier';
import { REPUTATION_ABI } from '../src/abis';
import { computeDidHash } from '../src/did';
import { evidenceLeaf, evidenceLayers, evidenceProof, evidenceRoot, hashPair } from '../src/evidence';

// sigvara_verify_evidence asked the reputation contract about each payment in a separate call. Arc's public RPC
// counts calls, and on 7 November 2026 it refused the 29th within a second with "rate limit exceeded", so the
// tool failed on every agent with a long payment history. This node refuses past 20 a second the same way.

const CHAIN = 5042002;
const AGENT = '0x9d7181c8676fd40e4b31510dc0e573a0c0c2fa11';
const DID_HASH = computeDidHash(AGENT, CHAIN);
const reputationAbi = new ethers.Interface(REPUTATION_ABI);
const multicallAbi = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

const payments = Array.from({ length: 60 }, (_, i) => ({
  txHash: ethers.zeroPadValue(ethers.toBeHex(i + 1), 32),
  payer: ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0xd00 + i), 20)),
  amount: String(BigInt(i + 1) * 10n ** 18n),
  settledAt: 1_700_000_000 + i * 60,
  success: true,
  outcomeSource: 'credentialed',
}));
const ROOT = evidenceRoot(payments.map((p) => evidenceLeaf(p)));

/** A node holding one agent's finalized root, refusing more than `limit` eth_calls a second. */
async function node({ limit = 20, multicall = true } = {}) {
  const seen = { ethCalls: 0, refused: 0, aggregate3: 0, single: 0 };
  let windowStart = Date.now();
  let inWindow = 0;
  const verify = (data: string) => {
    const [didHash, leaf, proof] = reputationAbi.decodeFunctionData('verifyEvidence', data);
    const ok = didHash === DID_HASH && (proof as string[]).reduce((acc, s) => hashPair(acc, s), leaf as string) === ROOT;
    return reputationAbi.encodeFunctionResult('verifyEvidence', [ok]);
  };
  const answer = (req: { id: unknown; method: string; params: any[] }) => {
    if (req.method === 'eth_chainId') return { result: ethers.toQuantity(CHAIN) };
    if (req.method === 'eth_getCode') {
      return { result: multicall && req.params[0].toLowerCase() === MULTICALL3.toLowerCase() ? '0x6080604052' : '0x' };
    }
    if (req.method !== 'eth_call') return { error: { code: -32601, message: `no ${req.method}` } };
    seen.ethCalls++;
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); inWindow = 0; }
    if (++inWindow > limit) { seen.refused++; return { error: { code: -32005, message: 'rate limit exceeded' } }; }
    const { to, data } = req.params[0];
    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      seen.aggregate3++;
      const [calls] = multicallAbi.decodeFunctionData('aggregate3', data);
      return { result: multicallAbi.encodeFunctionResult('aggregate3', [calls.map((c: any) => [true, verify(c.callData)])]) };
    }
    const selector = data.slice(0, 10);
    if (selector === reputationAbi.getFunction('evidenceRoots')!.selector) return { result: reputationAbi.encodeFunctionResult('evidenceRoots', [ROOT]) };
    if (selector === reputationAbi.getFunction('verifyEvidence')!.selector) { seen.single++; return { result: verify(data) }; }
    if (selector === reputationAbi.getFunction('getPendingScore')!.selector) {
      return { result: reputationAbi.encodeFunctionResult('getPendingScore', [[[0, 0, 0, 0, 0, 0, 0n], 0n, false, ethers.ZeroHash, ethers.ZeroAddress, 0n]]) };
    }
    return { error: { code: 3, message: 'execution reverted' } };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const reply = (r: any) => ({ jsonrpc: '2.0', id: r.id, ...answer(r) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('confirming a finalized root with the contract', () => {
  it('confirms 60 payments against a node that refuses more than 20 calls a second', async () => {
    const rpc = await node();
    try {
      const server = createTrustServer({
        chainId: CHAIN, addresses: ARC_TESTNET.addresses, rpcUrl: rpc.url,
        fetchEvidence: async () => ({ didHash: DID_HASH, evidence: payments.map((p) => ({ ...p, leaf: evidenceLeaf(p) })) }),
      });
      const r: any = await server.handle({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sigvara_verify_evidence', arguments: { agent: AGENT } },
      });
      const text = r.result.content[0].text;
      expect(r.result.isError, text).toBe(false);
      const value = JSON.parse(text);
      expect(value.finalized).toMatchObject({ reproduced: true, covers: 60, checkedWithContract: 60, confirmedByContract: 60 });
      expect(rpc.seen.refused).toBe(0);
      expect(rpc.seen.aggregate3).toBe(1);
      expect(rpc.seen.single).toBe(0);
    } finally {
      rpc.close();
    }
  });

  it('reads each answer from the batch, and asks one at a time where Multicall3 has no code', async () => {
    const layers = evidenceLayers(payments.map((p) => evidenceLeaf(p)));
    const good = { leaf: layers[0][3], proof: evidenceProof(layers, 3) };
    const bad = { leaf: evidenceLeaf({ ...payments[3], amount: '1' }), proof: evidenceProof(layers, 3) };
    const did = `did:sigvara:${CHAIN}:${AGENT}`;
    for (const multicall of [true, false]) {
      const rpc = await node({ multicall });
      try {
        const v = new SigvaraVerifier({ rpcUrl: rpc.url, addresses: ARC_TESTNET.addresses, chainId: CHAIN });
        expect(await v.verifyEvidenceMany(did, [good, bad, good]), `multicall ${multicall}`).toEqual([true, false, true]);
        expect(await v.verifyEvidenceMany(did, [])).toEqual([]);
        expect(rpc.seen.aggregate3, `multicall ${multicall}`).toBe(multicall ? 1 : 0);
        expect(rpc.seen.single, `multicall ${multicall}`).toBe(multicall ? 0 : 3);
      } finally {
        rpc.close();
      }
    }
  });
});
