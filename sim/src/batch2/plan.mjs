// What happens in one hour of the second batch, as a list of actions. Like the first batch's plan
// (../plan.mjs), a pure function of the cast, the seed and the hour: every action has an id, and the
// runner records the ids it has carried out, so a restart repeats nothing.

import { GROUPS, PRICE, HANDOVER, BONDING, REVIEW, RING_COVER } from './cast.mjs';
import { rng } from '../rng.mjs';

export const DAYS = 28;
export const HOURS = DAYS * 24;
// Share of delivered jobs whose payer posts a signed outcome, and of those, the share sent through
// CounterAudit rather than straight to the oracle.
const POST_SHARE = 0.85;
const VIA_COUNTERAUDIT = 0.3;

// Actions retried every tick until they are done, whatever hour they were planned for. A job is not
// one of them: it belongs to its hour and is skipped, not made up, once the hour has passed.
export const RETRIED = new Set([
  'fund', 'fund-base', 'register', 'stake', 'link', 'offer-transfer', 'accept-transfer',
  'leave-bond', 'rebond', 'review-fund', 'review-pay', 'review-post',
]);

/** Every action for hour `h` (0 is the first hour of the batch). */
export function planHour(cast, seed, h) {
  if (h < 0 || h >= HOURS) return [];
  const day = Math.floor(h / 24);
  const rand = rng(`${seed}:plan:${h}`);
  const out = [];
  const at = (d, hour = 0) => h === d * 24 + hour;

  // Setup, in the first hour. Gas on Arc for everyone who sends there; the ring's customers are
  // funded through the hub, which the ring's operator funds, so its money trail is two wallets long.
  // USDC on Base for everyone who pays there.
  if (h === 0) {
    const arcSenders = [
      ...cast.operators.map((o) => o.id),
      ...cast.payers.filter((p) => p.chain === 'arc').map((p) => p.id),
      cast.hub,
      ...cast.ringPayers.map((p) => p.id),
    ];
    for (const w of arcSenders) out.push({ id: `fund:${w}`, type: 'fund', wallet: w });
    const basePayers = [...cast.payers.filter((p) => p.chain === 'base').map((p) => p.id), cast.handover.from, cast.handover.to];
    for (const w of basePayers) out.push({ id: `fund-base:${w}`, type: 'fund-base', wallet: w });
  }
  for (const a of cast.agents) {
    if (at(a.day)) {
      out.push({ id: `register:${a.id}`, type: 'register', agent: a.id, operator: a.operator });
      out.push({ id: `stake:${a.id}`, type: 'stake', agent: a.id, operator: a.operator });
    }
  }
  // The reviewed agents link themselves to ERC-8004 identities on the first day, so reviews can reach them.
  if (at(1)) for (const id of cast.reviewed) out.push({ id: `link:${id}`, type: 'link', agent: id, operator: cast.reviewedOperator });

  // Jobs, for every agent bonded before this hour.
  const live = new Map(cast.agents.filter((a) => h > a.day * 24).map((a) => [a.id, a]));
  const job = (payer, agent, chain, opts = {}) => {
    const g = GROUPS[agent.group];
    const [lo, hi] = PRICE[chain];
    const amount = lo + Math.floor(rand() * (hi - lo + 1));
    const delivered = opts.delivered ?? rand() < g.success;
    const post = delivered && (opts.post ?? rand() < (agent.group === 'ring2' ? 1 : POST_SHARE));
    const via = post && rand() < VIA_COUNTERAUDIT ? 'counteraudit' : 'oracle';
    out.push({ id: `pay:${h}:${payer}:${chain}`, type: 'pay', chain, payer, agent: agent.id, amount, delivered, post, via, ...opts.tag && { tag: opts.tag } });
  };
  for (const payer of cast.payers) {
    if (rand() >= payer.rate / 24) continue;
    const options = payer.favourites.map((id) => live.get(id)).filter(Boolean);
    if (options.length) job(payer.id, options[Math.floor(rand() * options.length)], payer.chain);
  }
  for (const payer of cast.ringPayers) {
    if (rand() >= payer.rate / 24) continue;
    const list = rand() < RING_COVER ? payer.cover : payer.favourites;
    const options = list.map((id) => live.get(id)).filter(Boolean);
    if (options.length) job(payer.id, options[Math.floor(rand() * options.length)], 'arc');
  }

  // The handover. Before it, the operator-to-be buys from the agent like anyone (counted); on its day
  // the agent changes hands; after it, the former and the new operator both pay it, and the oracle
  // must refuse both as self_payment, on Arc and on Base.
  const ho = live.get(cast.handover.agent);
  if (ho && day >= HANDOVER.newBuyerFrom && day <= HANDOVER.newBuyerTo && at(day, 12)) {
    for (const chain of ['arc', 'base']) job(cast.handover.to, ho, chain, { delivered: true, post: true, tag: 'buyer-before-handover' });
  }
  if (at(HANDOVER.day)) {
    out.push({ id: 'handover:offer', type: 'offer-transfer', agent: cast.handover.agent, from: cast.handover.from, to: cast.handover.to });
    out.push({ id: 'handover:accept', type: 'accept-transfer', agent: cast.handover.agent, from: cast.handover.from, to: cast.handover.to });
  }
  if (ho && day >= HANDOVER.selfPayFrom && at(day, 12)) {
    for (const payer of [cast.handover.from, cast.handover.to]) {
      for (const chain of ['arc', 'base']) job(payer, ho, chain, { delivered: true, post: true, tag: payer === cast.handover.from ? 'former-operator' : 'new-operator' });
    }
  }

  // The bonding agent leaves its bond and comes back.
  if (at(BONDING.leave)) out.push({ id: 'bonding:leave', type: 'leave-bond', agent: cast.bonding });
  if (at(BONDING.back)) out.push({ id: 'bonding:back', type: 'rebond', agent: cast.bonding });

  // Reviewers. Funded and paying on one day, posting the next, so the oracle's daily snapshot holds
  // the payment before the feedback is read.
  if (at(REVIEW.fund)) {
    for (const r of [...REVIEW.shared, REVIEW.operatorFunded]) {
      out.push({ id: `review-fund:${r}`, type: 'review-fund', reviewer: r, from: r === REVIEW.operatorFunded ? cast.reviewedOperator : cast.treasury });
      for (const a of cast.reviewed) out.push({ id: `review-pay:${r}:${a}`, type: 'review-pay', reviewer: r, agent: a, amount: REVIEW.payment });
    }
  }
  if (at(REVIEW.post, 12)) {
    for (const r of [...REVIEW.shared, REVIEW.operatorFunded]) {
      for (const a of cast.reviewed) out.push({ id: `review-post:${r}:${a}`, type: 'review-post', reviewer: r, agent: a, rating: REVIEW.rating });
    }
  }
  return out;
}
