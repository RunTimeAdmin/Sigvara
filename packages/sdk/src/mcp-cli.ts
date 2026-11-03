#!/usr/bin/env node
/**
 * `sigvara-mcp`: the trust server on stdio. Configured by environment, so an MCP host's config can set it:
 *
 *   SIGVARA_RPC_URL      default https://rpc.testnet.arc.io
 *   SIGVARA_CHAIN_ID     default 5042002 (Arc testnet)
 *   SIGVARA_IDENTITY, SIGVARA_REPUTATION, SIGVARA_STAKING
 *                        the registries; default to the Arc testnet deployment on chain 5042002, and
 *                        required on any other chain
 *   SIGVARA_AUDIENCE     who the agents you check sign for: your own did:sigvara DID, or the origin they
 *                        reach you at. Without it, sigvara_challenge and sigvara_verify_proof are off.
 *   SIGVARA_EVIDENCE_URL an oracle serving GET /evidence/:didHash, for sigvara_verify_evidence; defaults to
 *                        the primary operator on chain 5042002. Without one, that tool is off.
 *   SIGVARA_TIMEOUT_MS   per-read timeout, default 30000
 *
 * Logs go to stderr. stdout carries the protocol and nothing else.
 */

import { ARC_TESTNET, createTrustServer, describeError, serveStdio } from './mcp';
import type { TrustServer } from './mcp';

function fail(message: string): never {
  process.stderr.write(`[sigvara-mcp] ${message}\n`);
  process.exit(1);
}

const env = process.env;
const chainId = env.SIGVARA_CHAIN_ID === undefined ? ARC_TESTNET.chainId : Number(env.SIGVARA_CHAIN_ID);
if (!Number.isInteger(chainId) || chainId <= 0) fail(`SIGVARA_CHAIN_ID must be a positive integer, got ${env.SIGVARA_CHAIN_ID}`);

const onArcTestnet = chainId === ARC_TESTNET.chainId;
const rpcUrl = env.SIGVARA_RPC_URL ?? (onArcTestnet ? ARC_TESTNET.rpcUrl : fail(`SIGVARA_RPC_URL is required on chain ${chainId}`));
const address = (name: 'IDENTITY' | 'REPUTATION' | 'STAKING', fallback: string) =>
  env[`SIGVARA_${name}`] ?? (onArcTestnet ? fallback : fail(`SIGVARA_${name} is required on chain ${chainId}`));
const addresses = {
  identity: address('IDENTITY', ARC_TESTNET.addresses.identity),
  reputation: address('REPUTATION', ARC_TESTNET.addresses.reputation),
  staking: address('STAKING', ARC_TESTNET.addresses.staking),
};
const timeoutMs = env.SIGVARA_TIMEOUT_MS === undefined ? undefined : Number(env.SIGVARA_TIMEOUT_MS);
const evidenceUrl = env.SIGVARA_EVIDENCE_URL ?? (onArcTestnet ? ARC_TESTNET.evidenceUrl : undefined);

let server: TrustServer;
try {
  server = createTrustServer({
    chainId, addresses, rpcUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env.SIGVARA_AUDIENCE ? { audience: env.SIGVARA_AUDIENCE } : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    // The RPC URL can hold a provider key, so it is redacted here as in what the model sees.
    onError: (err) => process.stderr.write(`[sigvara-mcp] read failed: ${describeError(err, [rpcUrl, evidenceUrl ?? ''])}\n`),
  });
} catch (err) {
  fail((err as Error).message);
}

let host = '<rpc>';
try { host = new URL(rpcUrl).host; } catch { /* reported by the first read */ }
process.stderr.write(`[sigvara-mcp] chain ${chainId} via ${host}, `
  + (server.audience === null ? 'proof tools off (no SIGVARA_AUDIENCE)\n' : `audience ${server.audience}\n`));
serveStdio(server).then(() => process.exit(0));
