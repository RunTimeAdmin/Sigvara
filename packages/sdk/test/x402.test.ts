import { describe, it, expect, vi } from 'vitest';
import { sigvaraX402Fetch, x402OffersFrom, X402SellerRefused, X402_MAX_BYTES, X402_MAX_OFFERS } from '../src/x402';
import type { TrustVerdict } from '../src/standing';

const GOOD = '0x1111111111111111111111111111111111111111';
const BAD = '0x2222222222222222222222222222222222222222';

const offer = (payTo: unknown) => ({ scheme: 'exact', network: 'eip155:8453', payTo, amount: '1000', asset: '0x3333333333333333333333333333333333333333' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

/** A 402 as a v2 server sends it (header), a v1 server sends it (body), or a mix of the two. */
function required(parts: { header?: unknown; rawHeader?: string; body?: unknown; rawBody?: string }): Response {
  const headers = new Headers();
  if (parts.header !== undefined) headers.set('PAYMENT-REQUIRED', encode(parts.header));
  if (parts.rawHeader !== undefined) headers.set('PAYMENT-REQUIRED', parts.rawHeader);
  const body = parts.rawBody ?? (parts.body === undefined ? undefined : JSON.stringify(parts.body));
  return new Response(body, { status: 402, headers });
}

const trustOnly = (...allowed: string[]) => ({
  check: vi.fn(async (agent: string): Promise<TrustVerdict> => (
    allowed.includes(agent) ? { ok: true, agent, score: 50 } : { ok: false, agent, reason: 'below_threshold', detail: 'low', score: 3 }
  )),
});

const guarded = (res: Response, trust: { check(agent: string): Promise<TrustVerdict> }) => (
  sigvaraX402Fetch((async () => res) as unknown as typeof fetch, trust)('https://seller.example/resource')
);

describe('x402OffersFrom', () => {
  it('reads the v2 header', async () => {
    const offers = await x402OffersFrom(required({ header: { x402Version: 2, accepts: [offer(GOOD)] } }));
    expect(offers?.map((o) => o.payTo)).toEqual([GOOD]);
  });

  it('reads the v1 body', async () => {
    const offers = await x402OffersFrom(required({ body: { x402Version: 1, accepts: [offer(GOOD)] } }));
    expect(offers?.map((o) => o.payTo)).toEqual([GOOD]);
  });

  it('reads a header in base64url', async () => {
    const url = encode({ accepts: [offer(GOOD), { note: '>>>???' }] }).replace(/\+/g, '-').replace(/\//g, '_');
    const offers = await x402OffersFrom(required({ rawHeader: url }));
    expect(offers?.[0].payTo).toBe(GOOD);
  });

  it('reads both when both are there, since a client could act on either', async () => {
    const offers = await x402OffersFrom(required({ header: { accepts: [offer(GOOD)] }, body: { accepts: [offer(BAD)] } }));
    expect(offers?.map((o) => o.payTo)).toEqual([GOOD, BAD]);
  });

  it('leaves the response readable', async () => {
    const res = required({ body: { accepts: [offer(GOOD)] } });
    await x402OffersFrom(res);
    expect(((await res.json()) as { accepts: { payTo: string }[] }).accepts[0].payTo).toBe(GOOD);
  });

  it('is null when nothing can be read', async () => {
    expect(await x402OffersFrom(required({ rawHeader: 'not base64 json!' }))).toBeNull();
    expect(await x402OffersFrom(required({ rawBody: '<html>pay me</html>' }))).toBeNull();
    expect(await x402OffersFrom(required({ body: { accepts: [] } }))).toBeNull();
    expect(await x402OffersFrom(required({ body: { accepts: 'none' } }))).toBeNull();
    expect(await x402OffersFrom(required({}))).toBeNull();
  });
});

describe('sigvaraX402Fetch', () => {
  it('leaves anything but a 402 alone, and asks nothing', async () => {
    const trust = trustOnly();
    const res = new Response('ok', { status: 200 });
    expect(await guarded(res, trust)).toBe(res);
    expect(trust.check).not.toHaveBeenCalled();
  });

  it('passes a 402 from a seller with standing, exactly as it arrived', async () => {
    const trust = trustOnly(GOOD);
    const res = required({ header: { accepts: [offer(GOOD)] } });
    expect(await guarded(res, trust)).toBe(res);
    expect(trust.check).toHaveBeenCalledWith(GOOD);
  });

  it('passes the request through unchanged', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const init = { method: 'POST', body: 'x' };
    await sigvaraX402Fetch(base as unknown as typeof fetch, trustOnly())('https://seller.example/a', init);
    expect(base).toHaveBeenCalledWith('https://seller.example/a', init);
  });

  it('refuses a seller without standing, and says why', async () => {
    const res = required({ body: { accepts: [offer(BAD)] } });
    const err = await guarded(res, trustOnly(GOOD)).catch((e) => e);
    expect(err).toBeInstanceOf(X402SellerRefused);
    expect(err.refused).toEqual([{ ok: false, agent: BAD, reason: 'below_threshold', detail: 'low', score: 3 }]);
    expect(err.message).toContain(BAD);
    expect(err.message).toContain('below_threshold');
  });

  it('refuses when any address offered fails, because the client picks among them', async () => {
    const res = required({ header: { accepts: [offer(GOOD), offer(BAD)] } });
    await expect(guarded(res, trustOnly(GOOD))).rejects.toBeInstanceOf(X402SellerRefused);
  });

  it('refuses a good header beside a bad body', async () => {
    const res = required({ header: { accepts: [offer(GOOD)] }, body: { accepts: [offer(BAD)] } });
    await expect(guarded(res, trustOnly(GOOD))).rejects.toBeInstanceOf(X402SellerRefused);
  });

  it('asks once about an address offered on several networks', async () => {
    const trust = trustOnly(GOOD);
    await guarded(required({ header: { accepts: [offer(GOOD), { ...offer(GOOD), network: 'eip155:42161' }] } }), trust);
    expect(trust.check).toHaveBeenCalledTimes(1);
  });

  it('refuses an offer with no payTo, as nothing can be checked', async () => {
    const res = required({ body: { accepts: [{ scheme: 'exact' }] } });
    const trust = {
      check: vi.fn(async (agent: string): Promise<TrustVerdict> => ({ ok: agent !== '', agent, reason: 'not_an_address' })),
    };
    const err = await guarded(res, trust).catch((e) => e);
    expect(err).toBeInstanceOf(X402SellerRefused);
    expect(err.message).toContain('(no payTo)');
  });

  it('refuses a 402 it cannot read, as a client that can would pay unchecked', async () => {
    const err = await guarded(required({ rawBody: 'pay up' }), trustOnly(GOOD)).catch((e) => e);
    expect(err).toBeInstanceOf(X402SellerRefused);
    expect(err.refused).toEqual([]);
  });

  it('rejects when the chain cannot be read, and no client gets the 402', async () => {
    const trust = { check: vi.fn(async (): Promise<TrustVerdict> => { throw new Error('could not read the chain'); }) };
    await expect(guarded(required({ body: { accepts: [offer(GOOD)] } }), trust)).rejects.toThrow('could not read the chain');
  });

  it('stops a payment client that wraps it from signing anything', async () => {
    // The shape of x402-fetch: call the inner fetch, and on a 402, sign and retry.
    const sign = vi.fn();
    const client = (inner: typeof fetch) => async (input: string) => {
      const first = await inner(input);
      if (first.status !== 402) return first;
      sign();
      return inner(input);
    };
    const pay = client(sigvaraX402Fetch((async () => required({ body: { accepts: [offer(BAD)] } })) as unknown as typeof fetch, trustOnly(GOOD)));
    await expect(pay('https://seller.example/resource')).rejects.toBeInstanceOf(X402SellerRefused);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('x402 guard limits', () => {
  it('refuses a body larger than the limit, and stops reading it', async () => {
    const big = JSON.stringify({ accepts: [offer(GOOD)], pad: 'x'.repeat(X402_MAX_BYTES) });
    const trust = trustOnly(GOOD);
    await expect(guarded(required({ rawBody: big }), trust)).rejects.toBeInstanceOf(X402SellerRefused);
    expect(trust.check).not.toHaveBeenCalled();
  });

  it('refuses a header larger than the limit', async () => {
    const big = encode({ accepts: [offer(GOOD)], pad: 'x'.repeat(X402_MAX_BYTES) });
    await expect(guarded(required({ rawHeader: big }), trustOnly(GOOD))).rejects.toBeInstanceOf(X402SellerRefused);
  });

  it('refuses more offers than the limit without checking any', async () => {
    const many = Array.from({ length: X402_MAX_OFFERS + 1 }, (_, i) => offer(`0x${(i + 1).toString(16).padStart(40, '0')}`));
    const trust = trustOnly();
    await expect(guarded(required({ body: { accepts: many } }), trust)).rejects.toBeInstanceOf(X402SellerRefused);
    expect(trust.check).not.toHaveBeenCalled();
  });

  it('checks one payee spelled two ways once, and at most four at a time', async () => {
    let running = 0;
    let most = 0;
    const payees = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, 'a')}`);
    const trust = {
      check: vi.fn(async (agent: string): Promise<TrustVerdict> => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return { ok: true, agent, score: 50 };
      }),
    };
    const offers = [...payees.map(offer), offer(payees[0].toUpperCase().replace('0X', '0x'))];
    const res = await guarded(required({ body: { accepts: offers } }), trust);
    expect(res.status).toBe(402);
    expect(trust.check).toHaveBeenCalledTimes(10);
    expect(most).toBeLessThanOrEqual(4);
  });
});
