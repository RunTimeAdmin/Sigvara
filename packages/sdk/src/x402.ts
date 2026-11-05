import type { TrustVerdict } from './standing';

/**
 * A check on who an x402 payment is about to go to, before it is signed.
 *
 * An x402 client wraps `fetch`: it sees a 402, picks an offer, signs a payment and retries. Nothing in
 * that asks whether the party being paid has any standing, and an `exact` payment is final once settled.
 * This wraps the `fetch` underneath the client, so it sees the 402 first, and a seller without standing
 * gets a rejected request and no signature:
 *
 *     const trust = new SigvaraTrustCheck({ rpcUrl, addresses, chainId: 5042002, minScore: 40 });
 *     const pay = wrapFetchWithPayment(sigvaraX402Fetch(fetch, trust), client);
 *
 * It reads what a client could act on: the v2 `PAYMENT-REQUIRED` header and the v1 JSON body, and if a
 * server sends both, both count. Every address offered must pass, not just one, because the client
 * chooses among them and this cannot know which it will choose. A 402 it cannot read is refused rather
 * than passed along, since a client that can read it would then pay unchecked.
 *
 * A seller's `payTo` has to be the agent's registered address for this to find it. A seller paid at
 * another address, or on a chain with its own addresses, reads as having no standing.
 */

/** One way a seller offers to be paid. Only `payTo` is read here. */
export interface X402Offer {
  payTo?: unknown;
  scheme?: unknown;
  network?: unknown;
}

export class X402SellerRefused extends Error {
  /** The verdict on each address offered that did not pass. Empty when the 402 could not be read. */
  readonly refused: TrustVerdict[];

  constructor(message: string, refused: TrustVerdict[]) {
    super(message);
    this.name = 'X402SellerRefused';
    this.refused = refused;
  }
}

function decodeHeader(value: string): unknown {
  const base64 = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const offersIn = (required: unknown): X402Offer[] | null => {
  const accepts = (required as { accepts?: unknown } | null)?.accepts;
  return Array.isArray(accepts) && accepts.length > 0 ? (accepts as X402Offer[]) : null;
};

/**
 * Every offer a 402 makes, from its header and its body, or null when neither can be read. Reads a clone,
 * so the response can still be read by whoever gets it next.
 */
export async function x402OffersFrom(res: Response): Promise<X402Offer[] | null> {
  const found: X402Offer[] = [];
  const header = res.headers.get('payment-required');
  if (header) {
    try {
      found.push(...(offersIn(decodeHeader(header)) ?? []));
    } catch { /* a header that does not decode offers nothing */ }
  }
  try {
    found.push(...(offersIn(await res.clone().json()) ?? []));
  } catch { /* a v2 response can have any body, or none */ }
  return found.length > 0 ? found : null;
}

/**
 * `baseFetch`, refusing with X402SellerRefused any 402 offering to pay an address without standing.
 * Anything else, including a 402 whose sellers all pass, comes back exactly as it arrived. A read of the
 * chain that fails rejects too: it says nothing about the seller, and no payment should follow from it.
 */
export function sigvaraX402Fetch(
  baseFetch: typeof fetch,
  trust: { check(agent: string): Promise<TrustVerdict> },
): typeof fetch {
  return async (input, init) => {
    const res = await baseFetch(input, init);
    if (res.status !== 402) return res;
    const offers = await x402OffersFrom(res);
    if (!offers) throw new X402SellerRefused('This 402 names no offer that can be read, so its seller cannot be checked.', []);
    const payees = [...new Set(offers.map((o) => String(o.payTo ?? '')))];
    const verdicts = await Promise.all(payees.map((p) => trust.check(p)));
    const refused = verdicts.filter((v) => !v.ok);
    if (refused.length > 0) {
      const named = refused.map((v) => `${v.agent || '(no payTo)'}: ${v.reason}`).join('; ');
      throw new X402SellerRefused(`Not paying this seller, which lacks standing. ${named}`, refused);
    }
    return res;
  };
}
