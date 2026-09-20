import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  base58Encode,
  base58Decode,
  hexToBytes,
  bytesToHex,
  seedToKeyPair,
  pubKeyToBytes32,
  bytes32ToPubKey,
  pubKeyToMultibase,
} from '../src/keys';

describe('base58', () => {
  it('round-trips arbitrary bytes', () => {
    const cases: Uint8Array[] = [
      new Uint8Array([0]),
      new Uint8Array([0, 0, 255]),
      new Uint8Array(32).fill(0xab),
      new Uint8Array(64).fill(0xff),
      nacl.randomBytes(64),
    ];
    for (const bytes of cases) {
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it('encodes known vectors', () => {
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
    expect(base58Encode(new Uint8Array([0, 1]))).toBe('12');
    expect(base58Encode(new Uint8Array([255]))).toBe('5Q');
  });

  it('throws on invalid base58 character', () => {
    expect(() => base58Decode('0OIl')).toThrow('Invalid base58 character');
  });
});

describe('hex encoding', () => {
  it('round-trips', () => {
    const bytes = nacl.randomBytes(32);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('handles 0x prefix', () => {
    expect(hexToBytes('0x0102')).toEqual(new Uint8Array([1, 2]));
  });

  it('throws on odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });

  // base58Decode has always rejected bad characters; hex never did. parseInt returns NaN
  // for a non-hex pair and Uint8Array writes NaN as 0, so the bad byte was silently
  // zeroed and a wrong-but-valid result came back.
  it('throws on a non-hex character rather than zeroing the byte', () => {
    expect(() => hexToBytes('zz')).toThrow(/non-hex character/);
    expect(() => hexToBytes('0xg1')).toThrow(/non-hex character/);
    expect(() => hexToBytes('ab  cd')).toThrow(/non-hex character/);
  });

  it('names the offending character and its position in the caller\'s string', () => {
    // "contains non-hex characters" is not much help against 64 of them.
    expect(() => hexToBytes('0xabcXef')).toThrow("'X' at index 5");
  });

  it('accepts mixed case', () => {
    expect(hexToBytes('AbCdEf')).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });
});

describe('seedToKeyPair', () => {
  it('derives consistent keypair from hex seed', () => {
    const seed = '0x' + 'ab'.repeat(32);
    const kp1 = seedToKeyPair(seed);
    const kp2 = seedToKeyPair(seed);
    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.secretKey).toEqual(kp2.secretKey);
  });

  it('derives consistent keypair from Uint8Array seed', () => {
    const seed = nacl.randomBytes(32);
    const kp1 = seedToKeyPair(seed);
    const kp2 = seedToKeyPair(seed);
    expect(kp1.publicKey).toEqual(kp2.publicKey);
  });

  it('different seeds produce different keypairs', () => {
    const kp1 = seedToKeyPair(nacl.randomBytes(32));
    const kp2 = seedToKeyPair(nacl.randomBytes(32));
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });

  it('throws on 31-byte seed', () => {
    expect(() => seedToKeyPair(new Uint8Array(31))).toThrow('32 bytes');
  });

  it('throws on wrong-length hex seed', () => {
    expect(() => seedToKeyPair('ab'.repeat(31))).toThrow('64 hex chars');
  });
});

describe('pubKey encoding', () => {
  it('bytes32 round-trips through Uint8Array', () => {
    const kp = seedToKeyPair(nacl.randomBytes(32));
    const bytes32 = pubKeyToBytes32(kp.publicKey);
    expect(bytes32).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bytes32ToPubKey(bytes32)).toEqual(kp.publicKey);
  });

  it('multibase has z prefix and ed25519-pub multicodec header', () => {
    const kp = seedToKeyPair(nacl.randomBytes(32));
    const mb = pubKeyToMultibase(kp.publicKey);
    expect(mb.startsWith('z')).toBe(true);
    // z-prefix is stripped, then the decoded bytes are the 0xed01 multicodec
    // header followed by the raw 32-byte key.
    const decoded = base58Decode(mb.slice(1));
    expect(decoded[0]).toBe(0xed);
    expect(decoded[1]).toBe(0x01);
    expect(decoded.slice(2)).toEqual(kp.publicKey);
  });
});

describe('hex validation reaches the callers that matter', () => {
  // The reason the hexToBytes fix is not cosmetic. A seed is 64 characters typed or
  // pasted by a human, and one wrong character used to produce a DIFFERENT valid
  // keypair with no error: the agent registers one public key, signs challenges with
  // another, and every authentication fails with nothing saying why.
  it('refuses a mistyped seed instead of deriving a different key', () => {
    const good = '9'.repeat(64);
    const typo = 'g' + '9'.repeat(63);

    const kp = seedToKeyPair(good);
    expect(() => seedToKeyPair(typo)).toThrow(/non-hex character/);

    // Guard against a "fix" that merely zeroes the byte: the two seeds must never
    // both succeed, because they do not produce the same key.
    const zeroed = '0'.repeat(2) + '9'.repeat(62);
    expect(seedToKeyPair(zeroed).publicKey).not.toEqual(kp.publicKey);
  });

  it('refuses a malformed bytes32 public key', () => {
    // Chain reads are well-formed, so this is defence in depth rather than a live bug.
    expect(() => bytes32ToPubKey('0x' + 'q'.repeat(64))).toThrow(/non-hex character/);
  });
});
