// The simulated cast: who exists, how each one behaves, and when it arrives.
//
// Everything here is a pure function of the configuration, so the cast is the same on every run
// and can be published before a single transaction is sent. Wallets are derived from one mnemonic
// by role and index (wallets.mjs); this file only says which indices exist and what they do.
//
// Every address the simulation controls is published (registry.mjs) and the explorer marks it, so
// nothing here can pass for outside demand. See docs/simulation.md.

/** How an agent behaves: the share of jobs it delivers, what a job costs, and how much demand it gets. */
export const PROFILES = {
  steady:   { success: 0.95, price: [10, 40], demand: 1.0 },
  mediocre: { success: 0.70, price: [5, 25],  demand: 0.8 },
  failing:  { success: 0.30, price: [5, 15],  demand: 0.8 },
  ring:     { success: 1.00, price: [50, 100], demand: 0 },
};

// Wallet index ranges, one per role, so a role's addresses never overlap another's.
export const INDEX = { treasury: 0, operator: 10, agent: 100, payer: 200, ringPayer: 300 };

// Operators and the agents each registers: [profile, day it registers].
const OPERATORS = [
  { name: 'steady-a', agents: [['steady', 0], ['steady', 0], ['steady', 0], ['steady', 0]] },
  { name: 'steady-b', agents: [['steady', 0], ['steady', 0], ['steady', 0], ['steady', 0]] },
  { name: 'mixed',    agents: [['mediocre', 0], ['mediocre', 0], ['failing', 0], ['failing', 0]] },
  { name: 'late',     agents: [['steady', 7], ['mediocre', 10], ['steady', 14], ['mediocre', 18]] },
  { name: 'solo',     agents: [['steady', 0]] },
  { name: 'ring',     agents: [['ring', 3], ['ring', 3], ['ring', 3]] },
];

export const PAYERS = 40;
export const RING_PAYERS = 6;

/**
 * The cast. Each agent has a stable id (its wallet index), its operator, profile and arrival day;
 * each payer a daily job rate and a set of favourite agents. The ring is paid only by ring payers,
 * and ring payers pay only the ring.
 */
export function buildCast(rand) {
  const operators = [], agents = [];
  OPERATORS.forEach((op, o) => {
    operators.push({ id: INDEX.operator + o, name: op.name });
    for (const [profile, day] of op.agents) {
      agents.push({ id: INDEX.agent + agents.length, operator: INDEX.operator + o, profile, day });
    }
  });
  const honest = agents.filter((a) => a.profile !== 'ring');
  const payers = Array.from({ length: PAYERS }, (_, i) => ({
    id: INDEX.payer + i,
    // Two to four jobs a day, and a handful of agents this payer goes back to.
    rate: 2 + rand() * 2,
    favourites: pick(honest, 3 + Math.floor(rand() * 4), rand).map((a) => a.id),
  }));
  const ring = agents.filter((a) => a.profile === 'ring');
  const ringPayers = Array.from({ length: RING_PAYERS }, (_, i) => ({ id: INDEX.ringPayer + i, rate: 6, favourites: ring.map((a) => a.id) }));
  return { operators, agents, payers, ringPayers, treasury: INDEX.treasury };
}

function pick(list, n, rand) {
  const pool = [...list], out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}
