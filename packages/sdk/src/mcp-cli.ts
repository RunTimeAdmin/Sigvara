#!/usr/bin/env node
/**
 * `sigvara-mcp`: the trust server on stdio. Configured by environment, so an MCP host's config can set it:
 *
 *   SIGVARA_RPC_URL      default https://rpc.testnet.arc.io
 *   SIGVARA_CHAIN_ID     default 5042002 (Arc testnet)
 *   SIGVARA_IDENTITY, SIGVARA_REPUTATION, SIGVARA_STAKING
 *                        the registries; default to the Arc testnet deployment on chain 5042002, and
 *                        required on any other chain
 *   SIGVARA_AUDIENCE     who signs for this server in sigvara_challenge; default unique to the process
 *   SIGVARA_TIMEOUT_MS   per-read timeout, default 30000
 *
 * Logs go to stderr. stdout carries the protocol and nothing else.
 */

import { FetchRequest } from 'ethers';
import { ARC_TESTNET, createTrustServer, serveStdio } from './mcp';
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

async function readChainId(): Promise<number> {
  const req = new FetchRequest(rpcUrl);
  req.timeout = timeoutMs ?? 30_000;
  req.body = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
  const res = await req.send();
  res.assertOk();
  const body = res.bodyJson as { result?: string; error?: { message?: string } };
  if (typeof body?.result !== 'string') throw new Error(`eth_chainId failed: ${body?.error?.message ?? 'no result'}`);
  return Number(BigInt(body.result));
}

let server: TrustServer;
try {
  server = createTrustServer({
    chainId, addresses, rpcUrl, readChainId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env.SIGVARA_AUDIENCE ? { audience: env.SIGVARA_AUDIENCE } : {}),
  });
} catch (err) {
  fail((err as Error).message);
}

process.stderr.write(`[sigvara-mcp] chain ${chainId} via ${new URL(rpcUrl).host}, audience ${server.audience}\n`);
serveStdio(server).then(() => process.exit(0));
