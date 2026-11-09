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

/** The most of a 402's body or `PAYMENT-REQUIRED` header this reads. A seller controls both. */
export const X402_MAX_BYTES = 64 * 1024;
/** The most offers one 402 may make. One with more is refused, not partly checked. */
export const X402_MAX_OFFERS = 16;
/** How many sellers are checked at once, so one 402 cannot start an unbounded burst of chain reads. */
const CHECKS_AT_ONCE = 4;

/** The body as text, or null when it is larger than `X402_MAX_BYTES`. Stops reading at the limit. */
async function boundedText(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > X402_MAX_BYTES) {
      // Not awaited: a clone's stream is one branch of a tee, and cancelling one branch settles only once the
      // other is cancelled too, which is the caller's to do.
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
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
 * Every offer a 402 makes, from its header and its body, or null when neither can be read, or when either is
 * larger than `X402_MAX_BYTES`: an oversized part is refused rather than skipped, since a client may act on it.
 * Reads a clone, so the response can still be read by whoever gets it next.
 */
export async function x402OffersFrom(res: Response): Promise<X402Offer[] | null> {
  const found: X402Offer[] = [];
  const header = res.headers.get('payment-required');
  if (header) {
    // Base64 is four characters for three bytes.
    if (header.length > Math.ceil(X402_MAX_BYTES / 3) * 4) return null;
    try {
      found.push(...(offersIn(decodeHeader(header)) ?? []));
    } catch { /* a header that does not decode offers nothing */ }
  }
  const text = await boundedText(res.clone());
  if (text === null) return null;
  try {
    found.push(...(offersIn(JSON.parse(text)) ?? []));
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
    if (offers.length > X402_MAX_OFFERS) {
      throw new X402SellerRefused(`This 402 makes ${offers.length} offers, more than the ${X402_MAX_OFFERS} checked.`, []);
    }
    // Addresses compare without case, so one payee spelled two ways is checked once.
    const byKey = new Map<string, string>();
    for (const o of offers) {
      const p = String(o.payTo ?? '');
      if (!byKey.has(p.toLowerCase())) byKey.set(p.toLowerCase(), p);
    }
    const payees = [...byKey.values()];
    const verdicts: TrustVerdict[] = [];
    for (let i = 0; i < payees.length; i += CHECKS_AT_ONCE) {
      verdicts.push(...await Promise.all(payees.slice(i, i + CHECKS_AT_ONCE).map((p) => trust.check(p))));
    }
    const refused = verdicts.filter((v) => !v.ok);
    if (refused.length > 0) {
      const named = refused.map((v) => `${v.agent || '(no payTo)'}: ${v.reason}`).join('; ');
      throw new X402SellerRefused(`Not paying this seller, which lacks standing. ${named}`, refused);
    }
    return res;
  };
}
