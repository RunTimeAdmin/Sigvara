import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { format, inspect } from 'node:util';
import { describe, it, expect } from 'vitest';

/**
 * The compiled package, which is what gets published.
 *
 * agent.test.ts checks the TypeScript source, and the source was right while 1.0.0-alpha.9 was out with
 * the key in an ordinary property: TypeScript's `private` keyword is erased when it compiles, so a test of
 * the source cannot see what the emitted code does. This loads dist/ the way a consumer does and looks for
 * the secret in every way an agent object ends up in a log, a response body or an error report.
 *
 * It needs `npm run build` first, which CI runs before the tests. Without a build it is skipped, except in
 * CI, where a missing build fails it instead of letting the check quietly disappear.
 */
const dist = resolve(__dirname, '../dist/index.js');
const built = existsSync(dist);

// Every byte different, so a run of them in some text can only be this seed.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256);
const SEED_HEX = Buffer.from(SEED).toString('hex');
const SEED_B64 = Buffer.from(SEED).toString('base64').slice(0, 12);
const RUN = Array.from(SEED.slice(0, 8));

/** Whether `nums` holds `run` as consecutive items, or at every second item (an index before each value). */
function hasRun(nums: number[], run: number[]): boolean {
  for (const stride of [1, 2]) {
    for (let i = 0; i + (run.length - 1) * stride < nums.length; i++) {
      if (run.every((v, k) => nums[i + k * stride] === v)) return true;
    }
  }
  return false;
}

/** The key as hex, as base64, or as a run of its bytes written out in decimal, whatever the separators. */
function leaks(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(SEED_HEX.slice(0, 24)) || text.includes(SEED_B64)) return true;
  return hasRun((text.match(/\d+/g) ?? []).map(Number), RUN);
}

describe.skipIf(!built)('the built package keeps the agent secret out of every rendering', () => {
  const sdk = built ? createRequire(__filename)(dist) : null;

  const makeAgent = () => new sdk.SigvaraAgent({
    privateKey: SEED, agentAddress: '0x00000000000000000000000000000000000000aa', chainId: 5042002,
  });

  it('is not in the JSON, the console output, a copy, or an error message', () => {
    const agent = makeAgent();
    const renderings: Record<string, string> = {
      'JSON.stringify': JSON.stringify(agent),
      'JSON.stringify of a spread copy': JSON.stringify({ ...agent }),
      'JSON.stringify of an Object.assign copy': JSON.stringify(Object.assign({}, agent)),
      'JSON.stringify of a structured clone': JSON.stringify(structuredClone(agent)),
      'JSON.stringify of the property descriptors': JSON.stringify(Object.getOwnPropertyDescriptors(agent)),
      'util.inspect, hidden properties shown': inspect(agent, { depth: 10, showHidden: true, maxArrayLength: 1000 }),
      'util.format': format('%j %o %O %s', agent, agent, agent, agent),
      'an error message that embeds the agent': new Error(`agent failed: ${JSON.stringify(agent)}`).message,
    };
    for (const [how, text] of Object.entries(renderings)) {
      expect(leaks(text), `${how} carries the secret`).toBe(false);
      expect(text, `${how} names the field`).not.toMatch(/secretKey|keyPair/);
    }
  });

  it('is not behind any property name the object has', () => {
    const agent = makeAgent();
    for (const key of Reflect.ownKeys(agent)) {
      expect(leaks(String(key)), `property ${String(key)}`).toBe(false);
      expect(leaks(inspect((agent as any)[key], { depth: 10, maxArrayLength: 1000 })), `value of ${String(key)}`).toBe(false);
    }
  });

  it('still signs, so the check above is not passing because the key went missing', () => {
    const agent = makeAgent();
    const peer = sdk.SigvaraAgent.generate({
      agentAddress: '0x00000000000000000000000000000000000000bb', chainId: 5042002,
    }).agent;
    const challenge = peer.issueChallenge(agent.did);
    const signature = agent.signChallengeFor(challenge.payload, peer.did);
    expect(sdk.verifyChallenge(challenge.payload, signature, sdk.bytes32ToPubKey(agent.publicKeyBytes32))).toBe(true);
  });

  it('would notice a leak: the detector finds the seed in the shapes an exposed key takes', () => {
    const bytes = Array.from(SEED);
    expect(leaks(JSON.stringify(Uint8Array.from(SEED)))).toBe(true);
    expect(leaks(JSON.stringify({ keyPair: { secretKey: Uint8Array.from(SEED) } }))).toBe(true);
    expect(leaks(inspect(Uint8Array.from(SEED), { maxArrayLength: 1000 }))).toBe(true);
    expect(leaks(bytes.join(', '))).toBe(true);
    expect(leaks(SEED_HEX)).toBe(true);
    expect(leaks('0x' + SEED_HEX.toUpperCase())).toBe(true);
    expect(leaks(Buffer.from(SEED).toString('base64'))).toBe(true);
    expect(leaks('nothing to see: 1, 2, 3, 4, 5, 6, 7, 8, 9')).toBe(false);
  });
});

describe('the build the key check depends on', () => {
  // Without dist/ the block above is skipped, so CI states plainly that it expects one.
  it.runIf(Boolean(process.env.CI))('exists in CI', () => {
    expect(built, 'run `npm run build` before the tests').toBe(true);
  });
});
