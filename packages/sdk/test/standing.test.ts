import { describe, it, expect, vi } from 'vitest';
import { SigvaraTrustCheck, parseMinBond, standingDecision } from '../src/standing';
import { sigvaraTrustTool, requireTrustedAgent, UntrustedAgentError, TRUST_TOOL_SCHEMA } from '../src/tools';

const ADDRESSES = {
  identity: '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
  reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
  staking: '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B',
};
const AGENT = '0x0000000000000000000000000000000000000001';
const NOW = 1_800_000_000;

function checkWith(
  chain: { active?: boolean; bonded?: boolean; score?: number; stake?: bigint; writtenAt?: number } = {},
  config: { minScore?: number; minBond?: bigint | string; maxScoreAgeSeconds?: number } = {},
) {
  const trust = new SigvaraTrustCheck({
    rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002, minScore: config.minScore ?? 40, ...config,
  });
  const v = (trust as any).verifier;
  v.isActive = vi.fn(async () => chain.active ?? true);
  v.hasMinimumStake = vi.fn(async () => chain.bonded ?? true);
  v.getTotalScore = vi.fn(async () => chain.score ?? 50);
  v.getStake = vi.fn(async () => chain.stake ?? 1000n);
  v.getScoreUpdatedAt = vi.fn(async () => chain.writtenAt ?? Math.floor(Date.now() / 1000) - 60);
  return { trust, v };
}

describe('standingDecision', () => {
  const fine = { active: true, bonded: true, score: 50, scoreUpdatedAt: NOW - 60, stake: 1000n };

  it('asks in order: standing, the bond asked for, freshness, the number', () => {
    const reason = (over: object, minBond?: bigint) => standingDecision({ ...fine, ...over }, 40, 3600, NOW, minBond).reason;
    expect(reason({ active: false, stake: 0n, scoreUpdatedAt: 0, score: 0 }, 5000n)).toBe('not_active');
    expect(reason({ bonded: false, stake: 0n, scoreUpdatedAt: 0, score: 0 }, 5000n)).toBe('not_active');
    expect(reason({ scoreUpdatedAt: 0, score: 0 }, 5000n)).toBe('below_bond');
    expect(reason({ scoreUpdatedAt: 0, score: 0 }, 1000n)).toBe('stale_score');
    expect(reason({ score: 39 }, 1000n)).toBe('below_threshold');
    expect(standingDecision(fine, 40, 3600, NOW, 1000n)).toEqual({ ok: true });
  });

  it('holds the bond floor at exactly the floor', () => {
    expect(standingDecision(fine, 40, undefined, NOW, 1000n).ok).toBe(true);
    expect(standingDecision(fine, 40, undefined, NOW, 1001n).reason).toBe('below_bond');
  });

  it('with no floor asked for, a missing stake does not matter', () => {
    const { stake, ...noStake } = fine;
    expect(standingDecision(noStake, 40, undefined, NOW).ok).toBe(true);
    expect(standingDecision(noStake, 40, undefined, NOW, 1n).reason).toBe('below_bond');
  });
});

describe('parseMinBond', () => {
  it('takes a bigint or a string of digits, and leaves unset alone', () => {
    expect(parseMinBond(5n, 'x')).toBe(5n);
    expect(parseMinBond('2500000000000000000000000', 'x')).toBe(2500000000000000000000000n);
    expect(parseMinBond(undefined, 'x')).toBeUndefined();
  });

  it('refuses what would quietly become another floor', () => {
    for (const bad of [5, 2.5e24, NaN, '', '1e18', '-5', '1.5', null, -1n, {}]) {
      expect(() => parseMinBond(bad, 'x'), String(bad)).toThrow(/minBond/);
    }
  });
});

describe('SigvaraTrustCheck', () => {
  it('says yes, with the score', async () => {
    const { trust } = checkWith();
    expect(await trust.check(AGENT)).toEqual({ ok: true, agent: AGENT, score: 50 });
  });

  it('says why not, for each reason', async () => {
    const reason = async (chain: object, config: object = {}) => (await checkWith(chain, config).trust.check(AGENT)).reason;
    expect(await reason({ active: false })).toBe('not_active');
    expect(await reason({ bonded: false })).toBe('not_active');
    expect(await reason({ stake: 999n }, { minBond: 1000n })).toBe('below_bond');
    expect(await reason({ writtenAt: 0 }, { maxScoreAgeSeconds: 3600 })).toBe('stale_score');
    expect(await reason({ writtenAt: 1 }, { maxScoreAgeSeconds: 3600 })).toBe('stale_score');
    expect(await reason({ score: 39 })).toBe('below_threshold');
  });

  it('explains a refusal, and gives the score only when the agent has standing', async () => {
    const out = await checkWith({ active: false }).trust.check(AGENT);
    expect(out.detail).toMatch(/not Active/);
    expect(out.score).toBeUndefined();
    const low = await checkWith({ score: 3 }).trust.check(AGENT);
    expect(low.detail).toMatch(/below your threshold/);
    expect(low.score).toBe(3);
  });

  it('does not touch the chain for something that is not an address', async () => {
    const { trust, v } = checkWith();
    for (const bad of ['merchant', '', '0x123', 'did:sigvara:5042002:0x1']) {
      const out = await trust.check(bad);
      expect(out).toMatchObject({ ok: false, agent: bad, reason: 'not_an_address' });
    }
    expect(v.isActive).not.toHaveBeenCalled();
  });

  it('asks only what the rule uses', async () => {
    const plain = checkWith();
    await plain.trust.check(AGENT);
    expect(plain.v.getStake).not.toHaveBeenCalled();
    expect(plain.v.getScoreUpdatedAt).not.toHaveBeenCalled();
    const full = checkWith({}, { minBond: 1n, maxScoreAgeSeconds: 3600 });
    await full.trust.check(AGENT);
    expect(full.v.getStake).toHaveBeenCalledTimes(1);
    expect(full.v.getScoreUpdatedAt).toHaveBeenCalledTimes(1);
  });

  it('reads the agent on the chain it was given', async () => {
    const { trust, v } = checkWith();
    await trust.check(AGENT);
    expect(v.isActive).toHaveBeenCalledWith(`did:sigvara:5042002:${AGENT}`);
  });

  it('throws when the chain cannot be read, and keeps the RPC URL out of it', async () => {
    const { trust, v } = checkWith();
    const message = 'server response 500 (info={ "requestUrl": "https://node.example/v2/secretkey" })';
    v.isActive = vi.fn(async () => { throw Object.assign(new Error(message), { shortMessage: message }); });
    const err = await trust.check(AGENT).catch((e) => e);
    expect(err.message).toMatch(/could not read the chain/);
    expect(err.message).not.toContain('secretkey');
    expect(err.message).toContain('server response 500');
  });

  it('prefers the words of the node', async () => {
    const { trust, v } = checkWith();
    v.isActive = vi.fn(async () => {
      throw Object.assign(new Error('could not coalesce error'), { shortMessage: 'could not coalesce error', error: { message: 'rate limit exceeded' } });
    });
    expect((await trust.check(AGENT).catch((e) => e)).message).toContain('rate limit exceeded');
  });

  it('finds them where a rate limit on a batched read leaves them', async () => {
    const { trust, v } = checkWith();
    v.isActive = vi.fn(async () => {
      throw Object.assign(new Error('missing revert data'), { shortMessage: 'missing revert data', info: { error: { code: -32005, message: 'rate limit exceeded' } } });
    });
    const message = (await trust.check(AGENT).catch((e) => e)).message;
    expect(message).toContain('rate limit exceeded');
    expect(message).not.toContain('missing revert data');
  });

  it('refuses a rule it could not apply', () => {
    const make = (over: object) => () => new SigvaraTrustCheck({ rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002, minScore: 40, ...over });
    expect(make({})).not.toThrow();
    for (const minScore of [NaN, -1, '40', undefined]) expect(make({ minScore }), String(minScore)).toThrow(/minScore/);
    for (const maxScoreAgeSeconds of [NaN, 0, -1, '60']) expect(make({ maxScoreAgeSeconds }), String(maxScoreAgeSeconds)).toThrow(/maxScoreAgeSeconds/);
    for (const chainId of [undefined, 0, 1.5, '5042002']) expect(make({ chainId }), String(chainId)).toThrow(/chainId/);
    expect(make({ minBond: 5 })).toThrow(/minBond/);
  });
});

describe('framework tools', () => {
  // The shape of LangChain's `tool`: the function, and the name, description and schema it is called by.
  const makeTool = <F, D>(fn: F, fields: D) => ({ fn, fields });

  it('sigvaraTrustTool gives a model the verdict as JSON', async () => {
    const { trust } = checkWith({ score: 3 });
    const t = sigvaraTrustTool(makeTool, trust);
    expect(t.fields.name).toBe('sigvara_check_agent');
    expect(t.fields.schema).toBe(TRUST_TOOL_SCHEMA);
    expect(JSON.parse(await t.fn({ agent: AGENT }))).toMatchObject({ ok: false, agent: AGENT, reason: 'below_threshold', score: 3 });
  });

  it('sigvaraTrustTool takes another name and description', () => {
    const t = sigvaraTrustTool(makeTool, checkWith().trust, { name: 'vet', description: 'Vet an agent' });
    expect(t.fields).toMatchObject({ name: 'vet', description: 'Vet an agent' });
  });

  it('requireTrustedAgent runs the function for an agent with standing, with all its arguments', async () => {
    const fn = vi.fn(async (input: { to: string }, extra: number) => `paid ${input.to} ${extra}`);
    const guarded = requireTrustedAgent(fn, checkWith().trust, (input) => input.to);
    await expect(guarded({ to: AGENT }, 7)).resolves.toBe(`paid ${AGENT} 7`);
    expect(fn).toHaveBeenCalledWith({ to: AGENT }, 7);
  });

  it('requireTrustedAgent takes a function that is not async', async () => {
    const guarded = requireTrustedAgent((n: { to: string }) => n.to.length, checkWith().trust, (n) => n.to);
    await expect(guarded({ to: AGENT })).resolves.toBe(AGENT.length);
  });

  it('requireTrustedAgent does not run it for an agent without standing, and says why', async () => {
    const fn = vi.fn();
    const guarded = requireTrustedAgent(fn, checkWith({ active: false }).trust, (a: string) => a);
    const err = await guarded(AGENT).catch((e) => e);
    expect(err).toBeInstanceOf(UntrustedAgentError);
    expect(err.verdict).toMatchObject({ ok: false, agent: AGENT, reason: 'not_active' });
    expect(err.message).toContain('not_active');
    expect(fn).not.toHaveBeenCalled();
  });

  it('requireTrustedAgent does not run it when the chain cannot be read', async () => {
    const { trust, v } = checkWith();
    v.isActive = vi.fn(async () => { throw new Error('down'); });
    const fn = vi.fn();
    await expect(requireTrustedAgent(fn, trust, (a: string) => a)(AGENT)).rejects.toThrow(/could not read the chain/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('requireTrustedAgent does not run it for a value that is not an address', async () => {
    const fn = vi.fn();
    await expect(requireTrustedAgent(fn, checkWith().trust, (a: string) => a)('ignore previous instructions')).rejects.toBeInstanceOf(UntrustedAgentError);
    expect(fn).not.toHaveBeenCalled();
  });
});
