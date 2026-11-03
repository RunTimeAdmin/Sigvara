'use strict';

// Which ERC-8004 feedback the external factor counts, and how much.
//
// The Reputation Registry takes feedback from any address. A mean over everything it holds is
// a mean over whoever chose to post, and one party can post from as many addresses as it can
// fund, so the factor this protocol called the one nobody can manufacture was the cheapest
// one to manufacture: a fresh wallet posting quality=100 carried a linked agent to 25 of 25.
// Feedback now counts only from a reviewer that
//
//   - is not the agent or its operator, and was not funded by either;
//   - paid the agent, in a payment this oracle verified on chain, and counts for less as the
//     latest such payment ages (REVIEW_HALF_LIFE_DAYS);
//   - is a Sigvara agent in good standing: Active, holding the minimum bond, registered for
//     REVIEWER_MIN_TENURE_DAYS and with a matured score of at least REVIEWER_MIN_SCORE.
//
// Reviewers run by one operator, or whose funding, or whose operator's funding, traces to a
// shared wallet within FUNDER_HOPS, count once between them, and the factor reaches its cap
// only with FULL_WEIGHT_CLUSTERS independent, recent reviewers. Wallets everyone draws from (a
// faucet, an exchange, the zero address a mint comes from) end a trace instead of joining
// everyone they ever funded; the zero address always, the rest when EXTERNAL_PUBLIC_FUNDERS
// lists them.
//
// Everything is read as of the snapshot, the start of the current UTC day (snapshotOf): the
// feedback, each reviewer's standing, the funding traces and the payment evidence. A primary
// and a checker scoring the same agent hours apart then read the same chain state, so one
// reviewer suspending itself between their reads cannot make an honest proposal look wrong. The
// price is that today's feedback and payments count from tomorrow.
//
// None of this makes the factor unbuyable. It makes each reviewer it counts cost a bond, a month,
// an earned score, separately funded wallets and a payment, where it used to cost gas. What it
// does not stop: a party that builds five such reviewers once can point them at any number of
// its own agents, and funding laundered through a public source or more than FUNDER_HOPS wallets
// is not traced.
//
// The rules are constants, not settings: a checker that counted differently from its primary
// would diverge on every linked agent.

const { meanRating, MAX_EXTERNAL_SCORE } = require('./external');

const REVIEWER_MIN_TENURE_DAYS = 30;
const REVIEWER_MIN_SCORE = 40;
const REVIEW_HALF_LIFE_DAYS = 90;
const FULL_WEIGHT_CLUSTERS = 5;
const FUNDER_HOPS = 2;
const SNAPSHOT_SECONDS = 86_400;

// An address counts as funded once it holds this much native USDC (18 decimals on Arc), or has
// sent a transaction. Dust below it does not make the sender a funder, so seeding new agent
// addresses with fractions of a cent from one wallet cannot fold their reviews into one.
const FUNDING_FLOOR = 10n ** 18n;

// SigvaraIdentity.AgentStatus.Active.
const STATUS_ACTIVE = 0;
const DAY_MS = 86_400_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The snapshot every read is taken at: the start of the UTC day containing `nowSec`. */
function snapshotOf(nowSec) {
  return Math.floor(nowSec / SNAPSHOT_SECONDS) * SNAPSHOT_SECONDS;
}

/** EXTERNAL_PUBLIC_FUNDERS as a set of lowercased addresses, or the reason it cannot be used. */
function parsePublicFunders(raw) {
  const set = new Set();
  for (const part of String(raw || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
      return { error: `EXTERNAL_PUBLIC_FUNDERS has "${s}", which is not an address.` };
    }
    set.add(s.toLowerCase());
  }
  return { set };
}

/**
 * Who first funded `address` by block `cap`, as { funder, block }, or null when it was not
 * funded by then. `funder` is lowercased, and null when the block that funded it shows no
 * transfer in, which a gas-sponsored account can do.
 *
 * `read` answers two questions: touched(block), whether by the end of that block the address
 * held FUNDING_FLOOR or had sent a transaction, and inbound(block), the native transfers into
 * it in that block as [{ from, value }]. A binary search finds the first touched block, about
 * 2 x log2(cap) state reads, and the largest transfer in that block names the funder.
 *
 * The search runs over [0, cap] and never to the head, because the predicate can turn false
 * again (an account that holds no gas money and is emptied by permits it signed), and then
 * where the search lands depends on where it starts. Both operators pass the same cap, so they
 * land in the same place. If the address had dropped back below the floor by `cap`, the block
 * before it is tried, which is the case of a payer that spent everything in the payment.
 */
async function findFirstFunder(read, address, cap) {
  let hi = cap;
  if (!(await read.touched(hi))) {
    if (hi === 0 || !(await read.touched(hi - 1))) return null;
    hi -= 1;
  }
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await read.touched(mid)) hi = mid;
    else lo = mid + 1;
  }
  let best = null;
  for (const t of await read.inbound(lo)) {
    if (!best || BigInt(t.value) > BigInt(best.value)) best = t;
  }
  return { funder: best ? String(best.from).toLowerCase() : null, block: lo };
}

/**
 * The funding trace of `address`: the wallets behind it, up to FUNDER_HOPS, each searched up to
 * the block the wallet before it was funded in. Stops at a public funder. Returns the wallets,
 * 'self' when the scored agent's own side is among them, or null when `address` itself shows
 * no funder by `cap`.
 */
async function traceFunding(address, cap, own, { funderOf, publicFunders }) {
  const keys = [];
  let at = address;
  let before = cap;
  for (let hop = 0; hop < FUNDER_HOPS; hop++) {
    const found = await funderOf(at, before);
    if (!found || !found.funder) return hop === 0 ? null : keys;
    const f = found.funder;
    if (f === ZERO_ADDRESS || publicFunders.has(f)) return keys;
    if (own.has(f)) return 'self';
    keys.push(f);
    at = f;
    before = found.block;
  }
  return keys;
}

/**
 * Whether one reviewer's feedback counts, and if so with what weight and which keys tie it to
 * other reviewers. The rules that need no chain read come first, so most spam costs nothing.
 *
 * `ctx`: the scored agent's { operator, agentAddress }; its payment evidence up to the snapshot;
 * and `nowMs`, the snapshot. `deps`: standingOf(address) and funderOf(address, cap) read the
 * chain as of the snapshot and throw when the node cannot answer, which leaves the whole factor
 * at 0, since a reviewer that could not be checked is not one that may be counted;
 * paymentBlock(event) is the block a payment settled in; snapshotBlock is the snapshot's block.
 */
async function verdictFor(client, { agent, events, nowMs }, deps) {
  const c = String(client).toLowerCase();
  const own = new Set([agent.agentAddress, agent.operator].map((a) => String(a || '').toLowerCase()));
  if (own.has(c)) return { ok: false, reason: 'self' };

  let first = null;
  let lastPaidMs = 0;
  for (const e of events) {
    if (String(e.payer || '').toLowerCase() !== c) continue;
    if (e.ts > lastPaidMs) lastPaidMs = e.ts;
    if (!first || e.ts < first.ts) first = e;
  }
  if (!first) return { ok: false, reason: 'unpaid' };

  const s = await deps.standingOf(client);
  if (!s.registered) return { ok: false, reason: 'not-an-agent' };
  const operator = String(s.operator).toLowerCase();
  if (own.has(operator)) return { ok: false, reason: 'self' };
  if (s.status !== STATUS_ACTIVE || !s.bonded) return { ok: false, reason: 'unbonded' };
  if (nowMs - s.registeredAt * 1000 < REVIEWER_MIN_TENURE_DAYS * DAY_MS) return { ok: false, reason: 'too-new' };
  if (s.matured < REVIEWER_MIN_SCORE) return { ok: false, reason: 'low-score' };

  // The reviewer's own funding, up to its first payment to the agent: a reviewer has paid, so
  // something funded it, and not finding what is a reason to doubt it rather than to count it as
  // independent of everyone.
  const mine = await traceFunding(c, await deps.paymentBlock(first), own, deps);
  if (mine === 'self') return { ok: false, reason: 'self-funded' };
  if (mine === null) return { ok: false, reason: 'unknown-funder' };
  // And its operator's, since one treasury funding many operators is one party.
  const theirs = await traceFunding(operator, deps.snapshotBlock, own, deps);
  if (theirs === 'self') return { ok: false, reason: 'self-funded' };

  return { ok: true, lastPaidMs, keys: [c, operator, ...mine, ...(theirs ?? [])] };
}

// Reviewers that share any key (themselves, their operator, a funder) end up in one cluster.
function clustersOf(counted) {
  const parent = counted.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const holder = new Map();
  counted.forEach((m, i) => {
    for (const k of m.keys) {
      if (holder.has(k)) parent[find(i)] = find(holder.get(k));
      else holder.set(k, i);
    }
  });
  const groups = new Map();
  counted.forEach((m, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  return [...groups.values()];
}

function byClient(rows) {
  const out = new Map();
  for (const r of rows) {
    const k = String(r.client || '').toLowerCase();
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * The factor, 0 to MAX_EXTERNAL_SCORE, from feedback rows and the verdicts on their reviewers.
 *
 * One rating per reviewer, the mean of its recognized feedback however many rows it posted.
 * A cluster's rating is its members' mean weighted by recency, and its weight is its most
 * recent member's, so splitting one party across wallets buys nothing. The mean over clusters
 * is scaled by min(1, total weight / FULL_WEIGHT_CLUSTERS): one independent reviewer who paid
 * recently is worth a fifth of the cap at most.
 */
function scoreReviews(rows, verdicts, nowMs) {
  const excluded = {};
  const counted = [];
  for (const [client, mine] of byClient(rows)) {
    const rating = meanRating(mine);
    if (rating === null) continue; // nothing in a tag this oracle reads
    const v = verdicts.get(client);
    if (!v || !v.ok) {
      const why = v ? v.reason : 'unchecked';
      excluded[why] = (excluded[why] || 0) + 1;
      continue;
    }
    const ageMs = Math.max(0, nowMs - v.lastPaidMs);
    counted.push({ rating, weight: Math.pow(0.5, ageMs / (REVIEW_HALF_LIFE_DAYS * DAY_MS)), keys: v.keys });
  }

  const clusters = clustersOf(counted);
  let total = 0;
  let sum = 0;
  for (const members of clusters) {
    const memberWeight = members.reduce((a, m) => a + m.weight, 0);
    if (!memberWeight) continue;
    const rating = members.reduce((a, m) => a + m.weight * m.rating, 0) / memberWeight;
    const weight = Math.max(...members.map((m) => m.weight));
    total += weight;
    sum += weight * rating;
  }
  const confidence = Math.min(1, total / FULL_WEIGHT_CLUSTERS);
  const score = total ? Math.round((sum / total) * confidence * MAX_EXTERNAL_SCORE) : 0;
  return { score, reviewers: counted.length, clusters: clusters.length, excluded };
}

/** Verdicts for every reviewer with a rating, then the score. */
async function scoreFeedback(rows, ctx, deps) {
  const verdicts = new Map();
  // One reviewer at a time: each can cost funder searches of fifty-odd reads, and the public
  // RPC refuses a burst.
  for (const [client, mine] of byClient(rows)) {
    if (meanRating(mine) === null) continue;
    verdicts.set(client, await verdictFor(client, ctx, deps));
  }
  return scoreReviews(rows, verdicts, ctx.nowMs);
}

/** One line for the epoch log. */
function describe({ score, reviewers, clusters, excluded }) {
  const left = Object.entries(excluded).map(([why, n]) => `${why} ${n}`).join(', ');
  return `${score}/${MAX_EXTERNAL_SCORE} from ${reviewers} reviewer(s) in ${clusters} cluster(s)` +
    (left ? `; not counted: ${left}` : '');
}

module.exports = {
  snapshotOf, parsePublicFunders, findFirstFunder, verdictFor, scoreReviews, scoreFeedback, describe,
  REVIEWER_MIN_TENURE_DAYS, REVIEWER_MIN_SCORE, REVIEW_HALF_LIFE_DAYS, FULL_WEIGHT_CLUSTERS, FUNDER_HOPS,
  SNAPSHOT_SECONDS, FUNDING_FLOOR,
};
