// What happens in one hour of the simulation, as a list of actions.
//
// A pure function of the cast, the seed and the hour, so a run can be replayed, inspected before it
// starts (`node sim/src/run.mjs --plan`), and resumed after a restart without doing anything twice:
// every action has an id, and the runner records the ids it has carried out.

import { PROFILES } from './cast.mjs';
import { rng } from './rng.mjs';

export const DAYS = 28;
export const HOURS = DAYS * 24;
// A slash the committee files by hand, on these days, against the first and second ring agents.
// The first goes undisputed; the ring's operator disputes the second and the admin rules.
export const SLASHES = [
  { day: 10, ring: 0, dispute: false },
  { day: 12, ring: 1, dispute: true },
];
// Share of delivered jobs whose payer posts a signed outcome. Not every customer bothers.
const POST_SHARE = 0.85;

/** The share of an agent's usual demand left on `day`: an agent that fails keeps losing customers. */
export function demandOn(agent, day) {
  const p = PROFILES[agent.profile];
  return p.demand * Math.pow(p.success, day / 7);
}

/**
 * Every action for hour `h` (0 is the first hour of the run). Setup happens in the hour an actor
 * arrives: gas and SVR for wallets, then registration and the bond for each agent. Jobs start the
 * hour after an agent's bond, so the oracle has a registered, bonded agent to score.
 */
export function planHour(cast, seed, h) {
  if (h < 0 || h >= HOURS) return [];
  const day = Math.floor(h / 24);
  const rand = rng(`${seed}:plan:${h}`);
  const out = [];
  const arrives = (d) => h === d * 24;

  // Setup. Operators and payers are funded in the first hour, whatever day their agents arrive.
  if (h === 0) {
    for (const w of [...cast.operators.map((o) => o.id), ...cast.payers.map((p) => p.id), ...cast.ringPayers.map((p) => p.id)]) {
      out.push({ id: `fund:${w}`, type: 'fund', wallet: w });
    }
  }
  for (const a of cast.agents) {
    if (arrives(a.day)) {
      out.push({ id: `register:${a.id}`, type: 'register', agent: a.id, operator: a.operator });
      out.push({ id: `stake:${a.id}`, type: 'stake', agent: a.id, operator: a.operator });
    }
  }

  // Jobs, for every agent bonded before this hour.
  const live = new Map(cast.agents.filter((a) => h > a.day * 24).map((a) => [a.id, a]));
  const job = (payer, agent) => {
    const p = PROFILES[agent.profile];
    const amount = p.price[0] + Math.floor(rand() * (p.price[1] - p.price[0] + 1));
    const delivered = rand() < p.success;
    const post = delivered && rand() < (agent.profile === 'ring' ? 1 : POST_SHARE);
    out.push({ id: `pay:${h}:${payer.id}`, type: 'pay', payer: payer.id, agent: agent.id, amount, delivered, post });
  };
  for (const payer of cast.payers) {
    if (rand() >= payer.rate / 24) continue;
    const options = payer.favourites.map((id) => live.get(id)).filter(Boolean);
    const weights = options.map((a) => demandOn(a, day));
    const total = weights.reduce((s, w) => s + w, 0);
    if (!total) continue;
    let r = rand() * total, chosen = options[0];
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { chosen = options[i]; break; } }
    job(payer, chosen);
  }
  for (const payer of cast.ringPayers) {
    if (rand() >= payer.rate / 24) continue;
    const options = payer.favourites.map((id) => live.get(id)).filter(Boolean);
    if (options.length) job(payer, options[Math.floor(rand() * options.length)]);
  }

  // Enforcement. The committee's filing is by hand; the runner checks every hour whether a filed
  // slash needs disputing (by the ring's operator) or executing (by anyone, once its window closes).
  const ring = cast.agents.filter((a) => a.profile === 'ring');
  for (const s of SLASHES) {
    if (arrives(s.day)) out.push({ id: `slash-due:${ring[s.ring].id}`, type: 'manual', step: 'file-slash', agent: ring[s.ring].id, dispute: s.dispute });
  }
  out.push({ id: `enforce:${h}`, type: 'enforce', slashes: SLASHES.map((s) => ({ agent: ring[s.ring].id, dispute: s.dispute })) });
  return out;
}
