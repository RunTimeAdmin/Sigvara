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
// Reviewers run by one operator, or whose funding traces to a shared wallet within
// FUNDER_HOPS, count once between them, and the factor reaches its cap only with
// FULL_WEIGHT_CLUSTERS independent, recent reviewers. Wallets everyone draws from (a faucet,
// an exchange) are listed in EXTERNAL_PUBLIC_FUNDERS and end a trace instead of joining
// everyone they ever funded.
//
// None of this makes the factor unbuyable. It makes each counted reviewer cost a bond, a
// month, an earned score, a separately funded wallet and a payment, where it used to cost gas.
//
// The rules are constants, not settings: a checker that counted differently from its primary
// would diverge on every linked agent.

const { meanRating, MAX_EXTERNAL_SCORE } = require('./external');

const REVIEWER_MIN_TENURE_DAYS = 30;
const REVIEWER_MIN_SCORE = 40;
const REVIEW_HALF_LIFE_DAYS = 90;
const FULL_WEIGHT_CLUSTERS = 5;
const FUNDER_HOPS = 2;

// SigvaraIdentity.AgentStatus.Active.
const STATUS_ACTIVE = 0;
const DAY_MS = 86_400_000;

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
 * The address that first funded `address`, lowercased, or null when there is none to find.
 *
 * `read` answers three questions about the chain: head(), touched(block) (did the address hold
 * a balance or had it sent a transaction by the end of that block), and inbound(block) (who
 * sent it native value in that block, in log order). A binary search finds the first touched
 * block, about 2 x log2(head) state reads, 54 at block 70 million, and the first inbound
 * transfer there names the funder. The answer does not change, so callers cache it.
 *
 * "Held a balance or had sent a transaction" turns true once and stays true for an ordinary
 * account, which is what makes the search valid. An account emptied without sending anything
 * (a permit someone else spent) could make it land on a later funding, which is still a real
 * funder of the address, only not the first.
 */
async function findFirstFunder(read, address) {
  const head = await read.head();
  if (!(await read.touched(head))) return null;
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await read.touched(mid)) hi = mid;
    else lo = mid + 1;
  }
  const from = await read.inbound(lo);
  return from.length ? String(from[0]).toLowerCase() : null;
}

/**
 * Whether one reviewer's feedback counts, and if so with what weight and which keys tie it to
 * other reviewers. The rules that need no chain read come first, so most spam costs nothing.
 *
 * `agent` is the scored agent's { operator, agentAddress }; `events` its payment evidence
 * (store.getPaymentEvents). `standingOf` and `funderOf` are chain reads that throw when the
 * node cannot answer, which leaves the whole factor at 0 for the epoch: a reviewer that could
 * not be checked is not one that may be counted.
 */
async function verdictFor(client, { agent, events, nowMs }, { standingOf, funderOf, publicFunders }) {
  const c = String(client).toLowerCase();
  const own = new Set([agent.agentAddress, agent.operator].map((a) => String(a || '').toLowerCase()));
  if (own.has(c)) return { ok: false, reason: 'self' };

  let lastPaidMs = 0;
  for (const e of events) {
    if (String(e.payer || '').toLowerCase() === c && e.ts > lastPaidMs) lastPaidMs = e.ts;
  }
  if (!lastPaidMs) return { ok: false, reason: 'unpaid' };

  const s = await standingOf(client);
  if (!s.registered) return { ok: false, reason: 'not-an-agent' };
  const operator = String(s.operator).toLowerCase();
  if (own.has(operator)) return { ok: false, reason: 'self' };
  if (s.status !== STATUS_ACTIVE || !s.bonded) return { ok: false, reason: 'unbonded' };
  if (nowMs - s.registeredAt * 1000 < REVIEWER_MIN_TENURE_DAYS * DAY_MS) return { ok: false, reason: 'too-new' };
  if (s.matured < REVIEWER_MIN_SCORE) return { ok: false, reason: 'low-score' };

  const keys = [c, operator];
  for (let at = c, hop = 0; hop < FUNDER_HOPS; hop++) {
    const funder = await funderOf(at);
    if (funder === null) {
      // A reviewer has paid, so something funded it. Not finding what is a reason to doubt it,
      // not to count it as independent of everyone.
      if (hop === 0) return { ok: false, reason: 'unknown-funder' };
      break;
    }
    if (publicFunders.has(funder)) break;
    if (own.has(funder)) return { ok: false, reason: 'self-funded' };
    keys.push(funder);
    at = funder;
  }
  return { ok: true, lastPaidMs, keys };
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
  // One reviewer at a time: each can cost a funder search of fifty-odd reads, and the public
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
  parsePublicFunders, findFirstFunder, verdictFor, scoreReviews, scoreFeedback, describe,
  REVIEWER_MIN_TENURE_DAYS, REVIEWER_MIN_SCORE, REVIEW_HALF_LIFE_DAYS, FULL_WEIGHT_CLUSTERS, FUNDER_HOPS,
};
