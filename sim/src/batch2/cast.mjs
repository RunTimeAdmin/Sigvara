// The second batch's cast: who exists, how each one behaves, and when it arrives. See
// docs/simulation.md, "Batch 2".
//
// The first batch (../cast.mjs) shows the protocol working on the path it was built for: SVR
// payments on Arc, payer outcomes, maturity and two slashes. This batch drives the paths that went
// live after it started and have carried almost nothing since: payments on Base Sepolia, a change of
// operator, an agent that leaves its bond and comes back, many agents arriving at once, outcomes
// carried through CounterAudit, ERC-8004 reviewers, and a ring that hides its funding one wallet
// further back and buys from honest agents too.
//
// A pure function of the configuration, like the first batch's. Wallets come from the same mnemonic,
// at indices from 1000, so no wallet is shared with the first batch except the five reviewers, which
// are first-batch agents used only after that batch has stopped.

/** How the agents of each group behave: the share of jobs delivered and the chains they are paid on. */
export const GROUPS = {
  base:     { success: 0.95, chains: ['base'] },
  dual:     { success: 0.95, chains: ['arc', 'base'] },
  handover: { success: 0.95, chains: ['arc', 'base'] },
  bonding:  { success: 0.95, chains: ['arc'] },
  burst:    { success: 0.85, chains: ['arc'] },
  reviewed: { success: 0.95, chains: ['arc'] },
  ring2:    { success: 1.00, chains: ['arc'] },
};

// What a job costs: whole SVR on Arc, cents of USDC on Base. The ring charges what honest agents do.
export const PRICE = { arc: [10, 40], base: [1, 10] };

// Wallet index ranges, one per role. The first batch uses 0 to 399.
export const INDEX = { treasury: 1000, operator: 1010, agent: 1100, payer: 1200, ringPayer: 1300, hub: 1400 };

// Operators and their agents: [group, day it registers]. handover-new registers nothing: it takes the
// handover agent on HANDOVER.day.
const OPERATORS = [
  { name: 'base-a',       agents: [['base', 0], ['base', 0], ['base', 0]] },
  { name: 'dual',         agents: [['dual', 0], ['dual', 0], ['dual', 0]] },
  { name: 'handover',     agents: [['handover', 0]] },
  { name: 'handover-new', agents: [] },
  { name: 'bonding',      agents: [['bonding', 0]] },
  { name: 'burst',        agents: Array.from({ length: 8 }, () => ['burst', 2]) },
  { name: 'reviewed',     agents: [['reviewed', 0], ['reviewed', 0], ['reviewed', 0]] },
  { name: 'ring2',        agents: [['ring2', 3], ['ring2', 3], ['ring2', 3]] },
];

export const ARC_PAYERS = 10;
export const BASE_PAYERS = 8;
export const RING_PAYERS = 6;
// Share of a ring customer's jobs that go to honest agents, so the ring's customers look like anyone's.
export const RING_COVER = 0.3;

// The handover agent changes operator on this day. handover-new pays it as a customer before; both
// the former and the new operator pay it after, which the oracle must refuse as self_payment.
export const HANDOVER = { day: 9, newBuyerFrom: 4, newBuyerTo: 8, selfPayFrom: 10 };

// The bonding agent suspends and withdraws its whole bond, then bonds again and returns to Active.
export const BONDING = { leave: 6, back: 9 };

// Reviewers: first-batch agents (../cast.mjs INDEX.agent is 100), steady and registered on that
// batch's first day, so 30 days old by the time they post. Five are funded from this batch's
// treasury, so they share a funder and should count as one; the sixth is funded by the reviewed
// agents' own operator, so it should not count at all.
export const REVIEW = { fund: 21, post: 22, shared: [100, 101, 102, 103, 104], operatorFunded: 105, payment: 10, rating: 90 };

/**
 * The cast. Each agent has a stable id (its wallet index), its operator, group and arrival day; each
 * payer the chain it pays on, a daily job rate and its favourite agents.
 */
export function buildCast(rand) {
  const operators = [], agents = [];
  OPERATORS.forEach((op, o) => {
    operators.push({ id: INDEX.operator + o, name: op.name });
    for (const [group, day] of op.agents) {
      agents.push({ id: INDEX.agent + agents.length, operator: INDEX.operator + o, group, day });
    }
  });
  const honest = agents.filter((a) => a.group !== 'ring2');
  const paidOn = (chain) => honest.filter((a) => GROUPS[a.group].chains.includes(chain));
  const payers = [
    ...Array.from({ length: ARC_PAYERS }, (_, i) => ({
      id: INDEX.payer + i, chain: 'arc', rate: 2 + rand() * 2,
      favourites: pick(paidOn('arc'), 3 + Math.floor(rand() * 4), rand).map((a) => a.id),
    })),
    ...Array.from({ length: BASE_PAYERS }, (_, i) => ({
      id: INDEX.payer + ARC_PAYERS + i, chain: 'base', rate: 1 + rand(),
      favourites: pick(paidOn('base'), 2 + Math.floor(rand() * 3), rand).map((a) => a.id),
    })),
  ];
  const ring = agents.filter((a) => a.group === 'ring2');
  const ringPayers = Array.from({ length: RING_PAYERS }, (_, i) => ({
    id: INDEX.ringPayer + i, chain: 'arc', rate: 4,
    favourites: ring.map((a) => a.id),
    cover: pick(paidOn('arc'), 3, rand).map((a) => a.id),
  }));
  const byName = (n) => operators.find((o) => o.name === n).id;
  return {
    operators, agents, payers, ringPayers,
    treasury: INDEX.treasury, hub: INDEX.hub,
    handover: { agent: agents.find((a) => a.group === 'handover').id, from: byName('handover'), to: byName('handover-new') },
    bonding: agents.find((a) => a.group === 'bonding').id,
    reviewed: agents.filter((a) => a.group === 'reviewed').map((a) => a.id),
    reviewedOperator: byName('reviewed'),
    ringOperator: byName('ring2'),
  };
}

function pick(list, n, rand) {
  const pool = [...list], out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}
