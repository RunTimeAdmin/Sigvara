/**
 * An MCP server that refuses tool calls from agents without standing.
 *
 * This is the forced gate. Everything else in Sigvara computes a number; this is a thing
 * that will not do work when the number is too low. Until something refuses,
 * `meetsThreshold` is an API nobody has to call.
 *
 * It also gives the Ed25519 challenge-response its first consumer. The registry has
 * stored that key since the beginning "for off-chain challenge-response auth", and the
 * two halves — prove who you are, then check what you are worth — only mean something
 * together. An authenticated caller with no standing is refused; a high-scoring agent who
 * cannot prove it is that agent is refused too.
 *
 *   node examples/mcp-gated-tool/server.mjs
 *
 * Speaks JSON-RPC 2.0 over stdio, which is what an MCP host expects. Two tools:
 *
 *   sigvara_challenge { did }                  -> a challenge to sign
 *   restricted_search { did, challenge, signature, query }
 *                                              -> the gated work
 *
 * The handshake is explicit rather than hidden in a transport header so the flow is
 * readable in a terminal. A production host would carry the proof once per session.
 */

import { createRequire } from 'node:module';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
// The published package, so this file works wherever it is copied to. Point it at
// ../../packages/sdk/dist/index.js instead when you are testing a change to the SDK
// that has not shipped yet.
const { SigvaraGate } = require('@sigvara/protocol-sdk');

const CHAIN_ID = Number(process.env.CHAIN_ID || 5042002);
const THRESHOLD = Number(process.env.SIGVARA_THRESHOLD || 35);

const gate = new SigvaraGate({
  rpcUrl: process.env.RPC_URL || 'https://rpc.testnet.arc.io',
  chainId: CHAIN_ID,
  addresses: {
    identity:   '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
    reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
    staking:    '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B',
  },
  threshold: THRESHOLD,
  // Signed into every challenge. A response given to this server cannot be replayed at
  // another one, which is why it must be stable and specific to this deployment.
  audience: process.env.SIGVARA_AUDIENCE || 'mcp://gated-tool.example',
});

/** Challenges we issued, by did. A real host would key these to a session. */
const outstanding = new Map();

const TOOLS = [
  {
    name: 'sigvara_challenge',
    description:
      'Step 1. Returns a challenge payload for your agent DID. Sign it with the Ed25519 ' +
      'key registered on chain for that DID and pass the signature to restricted_search.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string', description: 'did:sigvara:<chainId>:<address>' } },
      required: ['did'],
    },
  },
  {
    name: 'restricted_search',
    description:
      `Step 2. The gated tool. Refused unless the calling agent proves control of its DID ` +
      `and holds an on-chain Sigvara score of at least ${THRESHOLD}.`,
    inputSchema: {
      type: 'object',
      properties: {
        did:       { type: 'string' },
        challenge: { type: 'string', description: 'the payload from sigvara_challenge' },
        signature: { type: 'string', description: 'base58 Ed25519 signature over it' },
        query:     { type: 'string' },
      },
      required: ['did', 'challenge', 'signature', 'query'],
    },
  },
];

/** A refusal the caller can act on, rather than a bare denial. */
function refusal(r) {
  const why = {
    bad_proof: 'The signature did not verify against the Ed25519 key registered on chain '
      + 'for this DID, or it was issued for a different agent, audience or challenge.',
    replayed: 'That challenge has already been used. Call sigvara_challenge for a fresh one.',
    not_active: 'The agent is registered but not Active: it is unbonded, suspended, or slashed. '
      + 'Standing, not score — deposit the minimum stake, or it has been slashed and cannot recover.',
    below_threshold: `The agent is active and proved itself, but scores ${r.score} and this tool `
      + `requires ${r.threshold}. Score comes from payment-verified work; see sigvara.xyz/docs/reputation.`,
  }[r.reason] ?? 'Refused.';
  return { refused: true, reason: r.reason, score: r.score ?? null, threshold: r.threshold, detail: why };
}

async function handle(req) {
  const { id, method, params } = req;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  if (method === 'initialize') {
    return ok({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'sigvara-gated-tool', version: '0.1.0' },
    });
  }

  if (method === 'tools/list') return ok({ tools: TOOLS });

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};

    if (name === 'sigvara_challenge') {
      const c = gate.challenge(args.did);
      outstanding.set(args.did, c);
      return ok({ content: [{ type: 'text', text: JSON.stringify({
        challenge: c.payload, expiresAt: c.expiresAt, audience: gate.audience,
      }, null, 2) }] });
    }

    if (name === 'restricted_search') {
      // Compare against the challenge WE issued, never one the caller supplied. A gate
      // that verifies whatever payload arrives is verifying the attacker's homework.
      const issued = outstanding.get(args.did);
      if (!issued || issued.payload !== args.challenge) {
        return ok({ content: [{ type: 'text', text: JSON.stringify(
          { refused: true, reason: 'unknown_challenge', threshold: THRESHOLD,
            detail: 'No outstanding challenge for that DID matches. Call sigvara_challenge first.' },
          null, 2) }], isError: true });
      }
      outstanding.delete(args.did);

      const verdict = await gate.admit(args.did, issued, args.signature);
      if (!verdict.ok) {
        return ok({ content: [{ type: 'text', text: JSON.stringify(refusal(verdict), null, 2) }], isError: true });
      }

      // Admitted. The work itself is a stand-in; what matters is that reaching it
      // required standing that cost something to acquire and can be slashed.
      return ok({ content: [{ type: 'text', text: JSON.stringify({
        admitted: true, did: args.did, score: verdict.score, threshold: verdict.threshold,
        result: `results for ${JSON.stringify(args.query)}`,
      }, null, 2) }] });
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  try {
    const res = await handle(req);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e.message },
    }) + '\n');
  }
});

process.stderr.write(
  `[sigvara-gated-tool] threshold ${THRESHOLD}, audience ${gate.audience}, chain ${CHAIN_ID}\n`,
);
