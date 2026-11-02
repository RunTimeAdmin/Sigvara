import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { ARC_TESTNET, MCP_PROTOCOL_VERSIONS, TRUST_TOOLS, createTrustServer, serveStdio, standingDecision } from '../src/mcp';
import { SigvaraGate } from '../src/gate';
import { SigvaraVerifier } from '../src/verifier';
import { signChallenge } from '../src/challenge';
import { seedToKeyPair, pubKeyToBytes32 } from '../src/keys';
import { computeDidHash } from '../src/did';
import { AgentStatus, SlashState } from '../src/types';

const CHAIN = 5042002;
const AGENT = '0x00000000000000000000000000000000000000aa';
const DID = `did:sigvara:${CHAIN}:${AGENT}`;
const NOW = 1_800_000_000;
const SVR = 10n ** 18n;

type Chain = {
  registered?: boolean; status?: AgentStatus; active?: boolean; bonded?: boolean;
  score?: number; earned?: number; writtenAt?: number; stake?: bigint; minimum?: bigint;
  queued?: bigint; claimableAt?: bigint; slash?: SlashState; pending?: boolean; decimals?: number;
};

/**
 * The chain is stubbed on the verifier's methods, as in gate.test.ts. What is under test is what the server
 * asks, in what order it decides, and what it tells the caller; the contract reads are SigvaraVerifier's job.
 */
function stubbed(c: Chain = {}) {
  const v = new SigvaraVerifier({ rpcUrl: 'http://127.0.0.1:0', addresses: ARC_TESTNET.addresses, chainId: CHAIN }) as any;
  v.getIdentity = vi.fn(async () => ({
    operator: '0x00000000000000000000000000000000000000cc', agentAddress: AGENT,
    ed25519PubKey: '0x' + '11'.repeat(32), status: c.status ?? AgentStatus.Active,
    registeredAt: c.registered === false ? 0n : 1_700_000_000n,
  }));
  v.isActive = vi.fn(async () => c.active ?? true);
  v.hasMinimumStake = vi.fn(async () => c.bonded ?? true);
  v.getTotalScore = vi.fn(async () => c.score ?? 50);
  v.getEarnedScore = vi.fn(async () => c.earned ?? c.score ?? 50);
  v.getScoreUpdatedAt = vi.fn(async () => c.writtenAt ?? NOW - 60);
  v.getStake = vi.fn(async () => c.stake ?? 1000n * SVR);
  v.getMinimumStake = vi.fn(async () => c.minimum ?? 1000n * SVR);
  v.getPendingWithdrawal = vi.fn(async () => ({ amount: c.queued ?? 0n, claimableAt: c.claimableAt ?? 0n }));
  v.getSlashProposal = vi.fn(async () => ({
    state: c.slash ?? SlashState.None, reporter: '0x' + '0'.repeat(40), victim: '0x' + '0'.repeat(40),
    initiatedAt: 1_799_000_000n, challengeDeadline: 1_799_600_000n, disputedAt: 0n, evidenceHash: '0x',
  }));
  v.getPendingScore = vi.fn(async () => ({
    exists: c.pending ?? false,
    data: { feeScore: 10, successScore: 5, ageScore: 20, externalScore: 0, communityScore: 5, propagationScore: 0, lastUpdated: 0n },
    proposedAt: 1_799_990_000n, finalizableAt: 1_800_011_600n, evidenceRoot: '0x' + 'ab'.repeat(32), proposer: '0x' + '0'.repeat(39) + '1',
  }));
  v.getReputation = vi.fn(async () => ({
    feeScore: 10, successScore: 5, ageScore: 20, externalScore: 0, communityScore: 5, propagationScore: 0,
    lastUpdated: BigInt(c.writtenAt ?? NOW - 60), total: c.score ?? 50,
  }));
  v.getStakeTokenDecimals = vi.fn(async () => c.decimals ?? 18);
  return v as SigvaraVerifier & Record<string, any>;
}

function server(verifier: SigvaraVerifier, extra: Record<string, unknown> = {}) {
  return createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier, now: () => NOW, ...extra });
}

async function call(s: ReturnType<typeof server>, name: string, args: Record<string, unknown>) {
  const r: any = await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  expect(r.id).toBe(7);
  return { ...r.result, value: r.result.structuredContent, text: r.result.content[0].text };
}

describe('MCP protocol', () => {
  const s = server(stubbed());

  it('echoes a protocol version it speaks, and offers its newest otherwise', async () => {
    const asked: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect(asked.result.protocolVersion).toBe('2024-11-05');
    expect(asked.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(asked.result.serverInfo.name).toBe('sigvara-trust');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(asked.result.serverInfo.version).toBe(pkg.version);
    const unknown: any = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(unknown.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it('answers no notification, known or not', async () => {
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/whatever' })).toBeNull();
  });

  it('refuses malformed requests and unknown methods and tools with JSON-RPC errors', async () => {
    expect(((await s.handle({ id: 3, method: 'ping' })) as any).error.code).toBe(-32600);
    expect(((await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })) as any).error.code).toBe(-32601);
    const tool: any = await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sigvara_transfer', arguments: {} } });
    expect(tool.error.code).toBe(-32602);
    // A name inherited from Object.prototype is not a tool.
    const proto: any = await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'constructor', arguments: {} } });
    expect(proto.error.code).toBe(-32602);
    expect(((await s.handle({ jsonrpc: '2.0', id: 8, method: 'ping' })) as any).result).toEqual({});
  });

  it('lists six tools, every one read-only and taking an agent', async () => {
    const r: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.result.tools.map((t: any) => t.name)).toEqual([
      'sigvara_check_agent', 'sigvara_score', 'sigvara_stake', 'sigvara_identity', 'sigvara_challenge', 'sigvara_verify_proof',
    ]);
    for (const t of r.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.required).toContain('agent');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('serves newline-delimited JSON on streams, in order, and survives a bad line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    const done = serveStdio(s, { input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"}]\n');
    input.end();
    await done;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      [{ jsonrpc: '2.0', id: 2, result: {} }],
    ]);
  });
});

describe('ARC_TESTNET', () => {
  it('names the deployment recorded in deployments/5042002.json', () => {
    const d = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'deployments', '5042002.json'), 'utf8'));
    expect(ARC_TESTNET.chainId).toBe(d.chainId);
    expect(ARC_TESTNET.addresses).toEqual({ identity: d.identity, reputation: d.reputation, staking: d.staking });
  });
});

describe('sigvara_check_agent', () => {
  it('takes a 0x address on the configured chain and refuses a DID on another', async () => {
    const v = stubbed();
    const s = server(v);
    const r = await call(s, 'sigvara_check_agent', { agent: '0x00000000000000000000000000000000000000AA' });
    expect(r.isError).toBe(false);
    expect(r.value.agent).toEqual({ did: DID, didHash: computeDidHash(AGENT, CHAIN), chainId: CHAIN });
    expect(v.getIdentity).toHaveBeenCalledWith(DID);

    const other = await call(s, 'sigvara_check_agent', { agent: `did:sigvara:1:${AGENT}` });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/chain 1; this server reads chain 5042002/);
    const junk = await call(s, 'sigvara_check_agent', { agent: 'agent-42' });
    expect(junk.isError).toBe(true);
  });

  it('gives a decision only when asked for one, and validates the limits', async () => {
    const s = server(stubbed());
    expect((await call(s, 'sigvara_check_agent', { agent: DID })).value.decision).toBeUndefined();
    expect((await call(s, 'sigvara_check_agent', { agent: DID, threshold: 101 })).isError).toBe(true);
    expect((await call(s, 'sigvara_check_agent', { agent: DID, threshold: 2.5 })).isError).toBe(true);
    expect((await call(s, 'sigvara_check_agent', { agent: DID, maxScoreAgeSeconds: 0 })).isError).toBe(true);
    const ok = await call(s, 'sigvara_check_agent', { agent: DID, threshold: 40, maxScoreAgeSeconds: 3600 });
    expect(ok.value.decision).toEqual({ threshold: 40, maxScoreAgeSeconds: 3600, ok: true });
  });

  it('reports an unregistered agent as such, without reading anything else', async () => {
    const v = stubbed({ registered: false });
    const r = await call(server(v), 'sigvara_check_agent', { agent: DID, threshold: 0 });
    expect(r.value.status).toBe('NotRegistered');
    expect(r.value.decision.reason).toBe('not_active');
    expect(v.getTotalScore).not.toHaveBeenCalled();
  });

  it('refuses on standing before freshness, and on freshness before the number', async () => {
    const reasonFor = async (c: Chain, threshold = 40, maxScoreAgeSeconds?: number) =>
      (await call(server(stubbed(c)), 'sigvara_check_agent', { agent: DID, threshold, ...(maxScoreAgeSeconds ? { maxScoreAgeSeconds } : {}) })).value.decision.reason;
    expect(await reasonFor({ active: false, score: 90, writtenAt: 0 }, 40, 60)).toBe('not_active');
    expect(await reasonFor({ bonded: false, score: 90 })).toBe('not_active');
    expect(await reasonFor({ score: 10, writtenAt: NOW - 7200 }, 40, 3600)).toBe('stale_score');
    expect(await reasonFor({ score: 10, writtenAt: 0 }, 40, 3600)).toBe('stale_score');
    expect(await reasonFor({ score: 39 })).toBe('below_threshold');
  });

  it('says what is pending and what a slash could take, in the token\'s own decimals', async () => {
    const r = await call(server(stubbed({
      status: AgentStatus.Suspended, active: false, score: 30, earned: 45, slash: SlashState.Pending,
      stake: 1_500_000_000n, queued: 500_000_000n, claimableAt: 1_801_000_000n, minimum: 1_000_000_000n,
      pending: true, decimals: 6,
    })), 'sigvara_check_agent', { agent: DID });
    expect(r.value.stake).toEqual({
      held: '1500.0', queuedForWithdrawal: '500.0', minimum: '1000.0', slashable: '2000.0', victimShareIfSlashed: '500.0',
    });
    expect(r.value.signals.map((s: any) => s.code)).toEqual([
      'suspended', 'slash_pending', 'withdrawal_queued', 'score_maturing', 'score_pending',
    ]);
    expect(r.value.score).toEqual({ matured: 30, earned: 45, updatedAt: new Date((NOW - 60) * 1000).toISOString(), ageSeconds: 60 });
  });

  it('refuses every read when the RPC serves another chain, and asks again after an outage', async () => {
    const wrong = stubbed();
    const s = server(wrong, { readChainId: async () => 1 });
    const r = await call(s, 'sigvara_check_agent', { agent: DID });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/serves chain 1/);
    expect(wrong.getIdentity).not.toHaveBeenCalled();

    let attempts = 0;
    const flaky = server(stubbed(), { readChainId: async () => { if (++attempts === 1) throw new Error('timeout'); return CHAIN; } });
    expect((await call(flaky, 'sigvara_check_agent', { agent: DID })).isError).toBe(true);
    expect((await call(flaky, 'sigvara_check_agent', { agent: DID })).isError).toBe(false);
    expect(attempts).toBe(2);
  });
});

describe('agrees with SigvaraGate', () => {
  /**
   * The check is the gate's rule without the proof. Two layers that disagree about who passes are worse than
   * either being wrong, so every combination below goes through both and must come out the same.
   */
  it('on every combination of standing, freshness and score', async () => {
    const ages: (number | 'never')[] = [60, 7200, 'never'];
    let cases = 0;
    for (const active of [true, false]) for (const bonded of [true, false]) for (const score of [0, 39, 40, 90])
    for (const age of ages) for (const maxScoreAgeSeconds of [undefined, 3600]) {
      const writtenAt = age === 'never' ? 0 : Math.floor(Date.now() / 1000) - age;
      const gate = new SigvaraGate({
        rpcUrl: 'http://unused', addresses: ARC_TESTNET.addresses, chainId: CHAIN, threshold: 40, audience: 'https://t.example',
        ...(maxScoreAgeSeconds === undefined ? {} : { maxScoreAgeSeconds }),
      });
      const gv = (gate as any).verifier;
      gv.verifySignature = vi.fn(async () => true);
      gv.isActive = vi.fn(async () => active);
      gv.hasMinimumStake = vi.fn(async () => bonded);
      gv.getTotalScore = vi.fn(async () => score);
      gv.getScoreUpdatedAt = vi.fn(async () => writtenAt);
      const admitted = await gate.admit(DID, gate.challenge(DID), 'x');

      const s = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: stubbed({ active, bonded, score, writtenAt }) });
      const ours = (await call(s, 'sigvara_check_agent', { agent: DID, threshold: 40, ...(maxScoreAgeSeconds ? { maxScoreAgeSeconds } : {}) })).value.decision;
      expect({ ok: ours.ok, reason: ours.reason }, JSON.stringify({ active, bonded, score, age, maxScoreAgeSeconds }))
        .toEqual({ ok: admitted.ok, reason: admitted.reason });
      cases++;
    }
    expect(cases).toBe(96);
  });

  it('standingDecision orders its refusals the way the gate does', () => {
    expect(standingDecision({ active: false, bonded: true, score: 0, scoreUpdatedAt: 0 }, 40, 60, NOW).reason).toBe('not_active');
    expect(standingDecision({ active: true, bonded: true, score: 0, scoreUpdatedAt: 0 }, 40, 60, NOW).reason).toBe('stale_score');
    expect(standingDecision({ active: true, bonded: true, score: 0, scoreUpdatedAt: NOW }, 40, 60, NOW).reason).toBe('below_threshold');
    expect(standingDecision({ active: true, bonded: true, score: 40, scoreUpdatedAt: NOW }, 40, 60, NOW).ok).toBe(true);
  });
});

describe('sigvara_score, sigvara_stake and sigvara_identity', () => {
  it('report the factors, the earned and matured totals and a pending proposal', async () => {
    const r = await call(server(stubbed({ score: 33, earned: 40, pending: true })), 'sigvara_score', { agent: DID });
    expect(r.value.factors).toEqual({ feeScore: 10, successScore: 5, ageScore: 20, externalScore: 0, communityScore: 5, propagationScore: 0 });
    expect(r.value.earned).toBe(40);
    expect(r.value.matured).toBe(33);
    expect(r.value.pending.earned).toBe(40);
    expect(r.value.pending.finalizableAt).toBe(new Date(1_800_011_600 * 1000).toISOString());
  });

  it('report the stake, the queue and the last slash, and null for what there is none of', async () => {
    const none = await call(server(stubbed()), 'sigvara_stake', { agent: DID });
    expect(none.value.withdrawal).toBeNull();
    expect(none.value.lastSlash).toBeNull();
    const some = await call(server(stubbed({ slash: SlashState.Disputed, queued: 200n * SVR, claimableAt: 1_801_000_000n })), 'sigvara_stake', { agent: DID });
    expect(some.value.lastSlash.state).toBe('Disputed');
    expect(some.value.withdrawal).toEqual({ amount: '200.0', claimableAt: new Date(1_801_000_000 * 1000).toISOString() });
    expect(some.value.slashable).toBe('1200.0');
  });

  it('report an unregistered agent without a DID document', async () => {
    const r = await call(server(stubbed({ registered: false })), 'sigvara_identity', { agent: DID });
    expect(r.value).toMatchObject({ registered: false });
    expect(r.value.didDocument).toBeUndefined();
  });

  it('carry no bigint, so the text and the structured result are the same JSON', async () => {
    for (const name of ['sigvara_check_agent', 'sigvara_score', 'sigvara_stake']) {
      const r = await call(server(stubbed({ pending: true, slash: SlashState.Pending, queued: 1n })), name, { agent: DID, ...(name === 'sigvara_check_agent' ? { threshold: 10 } : {}) });
      expect(JSON.parse(r.text)).toEqual(r.value);
    }
  });
});

describe('sigvara_challenge and sigvara_verify_proof', () => {
  const kp = seedToKeyPair(new Uint8Array(32).fill(9));

  /** A real verifier whose identity contract holds kp's key, so the signature check is the real one. */
  function proving(standing: Chain = {}) {
    const v = stubbed(standing) as any;
    const real = new SigvaraVerifier({ rpcUrl: 'http://127.0.0.1:0', addresses: ARC_TESTNET.addresses, chainId: CHAIN }) as any;
    real._identity = {
      getIdentity: vi.fn(async () => ({
        operator: '0x00000000000000000000000000000000000000cc', agentAddress: AGENT,
        ed25519PubKey: pubKeyToBytes32(kp.publicKey), status: 0n, registeredAt: 1_700_000_000n,
      })),
    };
    v.verifySignature = vi.fn((...a: unknown[]) => real.verifySignature(...a));
    return v;
  }

  it('admits the agent that signs, once, and reports its standing', async () => {
    const v = proving({ score: 55 });
    const s = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: v, audience: 'agent://buyer' });
    const ch = (await call(s, 'sigvara_challenge', { agent: DID })).value;
    expect(ch.audience).toBe('agent://buyer');
    const signature = signChallenge(ch.challenge, kp.secretKey);
    const ok = await call(s, 'sigvara_verify_proof', { agent: DID, challenge: ch.challenge, signature, threshold: 50 });
    expect(ok.value.proved).toBe(true);
    expect(ok.value.decision).toEqual({ threshold: 50, maxScoreAgeSeconds: null, ok: true });
    const again = await call(s, 'sigvara_verify_proof', { agent: DID, challenge: ch.challenge, signature });
    expect(again.value).toMatchObject({ proved: false, reason: 'unknown_challenge' });
  });

  it('does not spend a challenge on a bad signature, so the real agent can still answer it', async () => {
    const s = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: proving() });
    const ch = (await call(s, 'sigvara_challenge', { agent: DID })).value;
    const forged = signChallenge(ch.challenge, seedToKeyPair(new Uint8Array(32).fill(1)).secretKey);
    expect((await call(s, 'sigvara_verify_proof', { agent: DID, challenge: ch.challenge, signature: forged })).value.reason).toBe('bad_proof');
    const real = signChallenge(ch.challenge, kp.secretKey);
    expect((await call(s, 'sigvara_verify_proof', { agent: DID, challenge: ch.challenge, signature: real })).value.proved).toBe(true);
  });

  it('refuses a challenge it did not issue, one issued for another agent, and one that has expired', async () => {
    let t = Math.floor(Date.now() / 1000);
    const v = proving();
    const s = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: v, now: () => t, challengeTtlSeconds: 60 });
    const other = `did:sigvara:${CHAIN}:0x00000000000000000000000000000000000000bb`;
    const forOther = (await call(s, 'sigvara_challenge', { agent: other })).value;
    const sig = signChallenge(forOther.challenge, kp.secretKey);
    expect((await call(s, 'sigvara_verify_proof', { agent: DID, challenge: forOther.challenge, signature: sig })).value.reason).toBe('unknown_challenge');
    expect((await call(s, 'sigvara_verify_proof', { agent: DID, challenge: 'sigvara-v2:made-up', signature: sig })).value.reason).toBe('unknown_challenge');

    const ch = (await call(s, 'sigvara_challenge', { agent: DID })).value;
    t += 61;
    const late = await call(s, 'sigvara_verify_proof', { agent: DID, challenge: ch.challenge, signature: signChallenge(ch.challenge, kp.secretKey) });
    expect(late.value.reason).toBe('unknown_challenge');
    expect(v.verifySignature).not.toHaveBeenCalled();
  });

  it('names its audience in every challenge, unique to the process unless one is given', () => {
    const a = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: stubbed() });
    const b = createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses, verifier: stubbed() });
    expect(a.audience).toMatch(/^sigvara-mcp:[0-9a-f-]{36}$/);
    expect(a.audience).not.toBe(b.audience);
  });
});

describe('createTrustServer', () => {
  it('refuses a configuration that would read the wrong place', () => {
    expect(() => createTrustServer({ chainId: 0, addresses: ARC_TESTNET.addresses, verifier: stubbed() })).toThrow(/chainId/);
    expect(() => createTrustServer({ chainId: CHAIN, addresses: { ...ARC_TESTNET.addresses, staking: 'nope' }, verifier: stubbed() })).toThrow(/staking/);
    expect(() => createTrustServer({ chainId: CHAIN, addresses: ARC_TESTNET.addresses })).toThrow(/rpcUrl/);
  });

  it('describes every tool it lists', () => {
    for (const t of TRUST_TOOLS) expect(t.description.length).toBeGreaterThan(40);
  });
});
