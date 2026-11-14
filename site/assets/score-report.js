"use strict";
// The scores as a whole, on the status page. It shows how they spread across the bands a threshold
// is set in, how many agents moved band from one day to the next, and how often each band was
// followed by a bad outcome.
//
// A score that most agents share tells a counterparty little. A score that is not followed by
// better behaviour than a lower one predicts nothing. Neither shows in any one agent's page, and
// nothing else measures them.
//
// Your browser computes it when the page opens, like the rest of the page, from three sources:
//   - Sigvara's event index: registrations, score writes, slashes and withdrawals;
//   - the chain: the matured scores a threshold is checked against;
//   - the primary oracle: payers' signed "not delivered" outcomes.
// The arithmetic is kept apart from the page so that oracle/score-report.test.js can test it.
(function (root) {
  const X = root.SigvaraExplorer || (typeof require === "function" ? require("./explorer.js") : null);

  // The bands, in points. The edges are the thresholds the docs use (30, 40 and 50), and the point
  // past which a threshold starts to carry information (about 60, docs/whitepaper.md 5.3).
  const BANDS = [[0, 29], [30, 39], [40, 49], [50, 59], [60, 79], [80, 100]];
  const DAY = 86400;
  // How long after a score an outcome still counts against it.
  const WINDOW_DAYS = 30;
  // Days shown in the day-by-day table.
  const SERIES_DAYS = 14;
  // Pages of /outcomes read, at 500 outcomes a page. Past this the page says it stopped reading.
  const OUTCOME_PAGES = 20;
  // The value of `outcome` in a payer-signed "not delivered" (docs/adr/0011).
  const NOT_DELIVERED = 2;
  // Index matches SigvaraIdentity.AgentStatus.
  const ACTIVE = 0;

  // Joined with no-break spaces so a narrow table does not split a band across lines.
  const bandLabel = (i) => `${BANDS[i][0]} to ${BANDS[i][1]}`;

  // The band a score is in, or -1 for anything that is not a whole number from 0 to 100.
  function bandOf(score) {
    if (!Number.isInteger(score) || score < 0 || score > 100) return -1;
    return BANDS.findIndex(([lo, hi]) => score >= lo && score <= hi);
  }

  // The Shannon entropy of a count per band, in bits: 0 when every agent is in one band, and log2 of
  // the number of bands when they are spread evenly. A registry where 97% hold one verdict is at 0.2.
  function entropyBits(counts) {
    const n = counts.reduce((a, b) => a + b, 0);
    let h = 0;
    for (const c of counts) {
      if (c > 0) h -= (c / n) * Math.log2(c / n);
    }
    return h;
  }

  // How a list of scores spreads across the bands.
  function spread(scores) {
    const counts = BANDS.map(() => 0);
    for (const s of scores) {
      const b = bandOf(s);
      if (b >= 0) counts[b] += 1;
    }
    const agents = counts.reduce((a, b) => a + b, 0);
    const top = counts.indexOf(Math.max(...counts));
    return { agents, counts, bits: entropyBits(counts), maxBits: Math.log2(BANDS.length), top, topShare: agents ? counts[top] / agents : 0 };
  }

  // Every score written, in chain order, as { did, score, time }. ReputationUpdated carries the
  // earned total; ReputationZeroed sets it to 0. Anything malformed is left out.
  function scoreWrites(logs) {
    const writes = [];
    for (const l of logs) {
      const did = String(l?.topics?.[1] ?? "").toLowerCase();
      if (!X.isHash(did) || !Number.isSafeInteger(l.time)) continue;
      if (l.name === "ReputationZeroed") {
        writes.push({ did, score: 0, time: l.time });
      } else if (l.name === "ReputationUpdated" && X.strip(l.data).length >= 64) {
        const score = Number(BigInt(X.word(l.data, 0)));
        if (score <= 100) writes.push({ did, score, time: l.time });
      }
    }
    return writes;
  }

  // Each agent's newest score written before `t` (seconds), from writes in chain order.
  function scoresAt(writes, t) {
    const at = new Map();
    for (const w of writes) {
      if (w.time >= t) break;
      at.set(w.did, w.score);
    }
    return at;
  }

  // One row per whole UTC day, the newest last, for the `days` days before today. Each row says how
  // the scores spread at the day's end, and how many agents scored at both ends of the day ended it
  // in another band.
  function dailySeries(writes, now, days = SERIES_DAYS) {
    const today = Math.floor(now / DAY) * DAY;
    const rows = [];
    let before = scoresAt(writes, today - days * DAY);
    for (let k = days; k >= 1; k--) {
      const start = today - k * DAY;
      const after = scoresAt(writes, start + DAY);
      let moved = 0, compared = 0;
      for (const [did, s] of after) {
        if (!before.has(did)) continue;
        compared += 1;
        if (bandOf(s) !== bandOf(before.get(did))) moved += 1;
      }
      rows.push({ day: start, ...spread([...after.values()]), moved, compared });
      before = after;
    }
    return rows;
  }

  // The outcomes the chain records against an agent, as { did, time, kind }.
  const CHAIN_KINDS = { SlashExecuted: "slashed", SlashInitiated: "accused", WithdrawalInitiated: "withdrew" };
  function chainOutcomes(logs) {
    const out = [];
    for (const l of logs) {
      const kind = CHAIN_KINDS[l?.name];
      const did = String(l?.topics?.[1] ?? "").toLowerCase();
      if (kind && X.isHash(did) && Number.isSafeInteger(l.time)) out.push({ did, time: l.time, kind });
    }
    return out;
  }

  // Payers' signed "not delivered" outcomes from /outcomes, timed when the payer signed them.
  function payerNegatives(outcomes) {
    const out = [];
    for (const o of outcomes) {
      const did = String(o?.didHash ?? "").toLowerCase();
      const time = Number(o?.signedAt);
      if (o?.outcome === NOT_DELIVERED && X.isHash(did) && Number.isSafeInteger(time)) out.push({ did, time, kind: "notDelivered" });
    }
    return out;
  }

  // Whether a score was followed by a bad outcome. The unit is an agent-day: each agent's score at
  // the end of each UTC day, against what happened to that agent in the `windowDays` after. Counted
  // that way, an agent weighs the same whether its score was written once that day or every hour.
  // Only days whose window has passed count, so a recent score is not taken as clean for want of
  // time. Bad means a slash executed or a payer's "not delivered". An accusation and the start of
  // a withdrawal are counted beside it, and are not in it.
  function calibration(writes, outcomes, now, windowDays = WINDOW_DAYS) {
    const rows = BANDS.map(() => ({ agentDays: 0, bad: 0, accused: 0, withdrew: 0 }));
    const window = windowDays * DAY;
    const lastEnd = Math.floor((now - window) / DAY) * DAY;
    const result = { rows, days: 0, firstEnd: null, lastEnd: null, windowDays };
    if (!writes.length) return result;
    const byDid = new Map();
    for (const o of outcomes) {
      if (!byDid.has(o.did)) byDid.set(o.did, []);
      byDid.get(o.did).push(o);
    }
    for (let end = Math.floor(writes[0].time / DAY) * DAY + DAY; end <= lastEnd; end += DAY) {
      if (result.firstEnd === null) result.firstEnd = end;
      result.lastEnd = end;
      result.days += 1;
      for (const [did, score] of scoresAt(writes, end)) {
        const b = bandOf(score);
        if (b < 0) continue;
        const kinds = new Set((byDid.get(did) ?? []).filter((o) => o.time >= end && o.time < end + window).map((o) => o.kind));
        rows[b].agentDays += 1;
        if (kinds.has("slashed") || kinds.has("notDelivered")) rows[b].bad += 1;
        if (kinds.has("accused")) rows[b].accused += 1;
        if (kinds.has("withdrew")) rows[b].withdrew += 1;
      }
    }
    return result;
  }

  // ---- reading ----

  // Every payer-signed outcome the primary publishes, a page at a time.
  async function readOutcomes() {
    const outcomes = [];
    let since = 0, more = true;
    for (let page = 0; more && page < OUTCOME_PAGES; page++) {
      const j = await X.getJson(`${X.PRIMARY}/outcomes?since=${since}`);
      if (!Array.isArray(j?.outcomes)) throw new Error("the answer has no list of outcomes");
      outcomes.push(...j.outcomes);
      more = j.more === true;
      const next = Number(j.next);
      if (!Number.isSafeInteger(next) || next <= since) break;
      since = next;
    }
    return { outcomes, complete: !more };
  }

  // Whose an agent is, as far as the repository and the simulation's list say.
  function isOwn(agent) {
    return Boolean(X.KNOWN_AGENTS[agent.didHash]) || Boolean(X.simAgent(agent.address))
      || X.same(agent.operator, X.DEPLOYER) || X.same(agent.operator, X.DRILL_OPERATOR);
  }

  // Everything the card needs, read now.
  async function readAll() {
    const [registrations, reputation, staking, payer] = await Promise.all([
      X.contractLogs(X.IDENTITY, ["AgentRegistered"]),
      X.contractLogs(X.REPUTATION, ["ReputationUpdated", "ReputationZeroed"]),
      X.contractLogs(X.STAKING, Object.keys(CHAIN_KINDS)),
      readOutcomes().catch((e) => ({ error: String(e?.message ?? e) })),
      X.loadSimulation(),
    ]);
    const seen = new Set();
    const agents = registrations.logs
      .map((l) => ({ didHash: l.topics[1], address: X.topicAddr(l.topics[3]) }))
      .filter((a) => X.isHash(a.didHash) && X.isAddr(a.address) && !seen.has(a.didHash) && seen.add(a.didHash));
    const reads = agents.length ? await X.ethCalls(agents.flatMap((a) => [
      { to: X.IDENTITY,   data: X.SEL.identities    + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.getTotalScore + X.pad32(a.didHash) },
    ])) : [];
    agents.forEach((a, i) => {
      const [ident, total] = reads.slice(i * 2, i * 2 + 2);
      a.operator = X.wordAddr(ident, 0);
      a.status = Number(BigInt(X.word(ident, 3)));
      a.total = Number(BigInt(total));
    });
    return { agents, reputation, staking, payer, simUnknown: X.simUnknown() };
  }

  // The report, from what readAll read. `now` is in seconds.
  function build(data, now) {
    const active = data.agents.filter((a) => a.status === ACTIVE);
    const writes = scoreWrites(data.reputation.logs);
    const outcomes = [...chainOutcomes(data.staking.logs), ...(data.payer.outcomes ? payerNegatives(data.payer.outcomes) : [])];
    const own = new Set(data.agents.filter(isOwn).map((a) => a.didHash));
    const bad = outcomes.filter((o) => o.kind !== "withdrew");
    return {
      now,
      active: active.length,
      outside: active.filter((a) => !isOwn(a)).length,
      simUnknown: data.simUnknown,
      matured: spread(active.map((a) => a.total)),
      series: dailySeries(writes, now),
      calibration: calibration(writes, outcomes, now),
      notDelivered: outcomes.filter((o) => o.kind === "notDelivered").length,
      // Slashes, accusations and "not delivered" reports, by whose agent they were against.
      against: { own: bad.filter((o) => own.has(o.did)).length, outside: bad.filter((o) => !own.has(o.did)).length },
      payer: data.payer.error ? { error: data.payer.error } : { read: data.payer.outcomes.length, complete: data.payer.complete },
    };
  }

  // ---- the card ----

  const pct = (x) => `${Math.round(x * 100)}%`;
  const bits = (x) => x.toFixed(2);
  // A UTC date, with no-break hyphens for the same reason.
  const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10).replace(/-/g, "‑");

  function render(r, notes = "") {
    const n = (x) => Number(x).toLocaleString("en-US");
    let html = "";
    if (r.simUnknown) {
      html += `<p class="pill-warn">The simulation's list of agents could not be read, so this page cannot tell outside agents from Sigvara's own.</p>`;
    } else if (r.outside === 0) {
      html += `<p class="netnote">None of the ${n(r.active)} Active agents is an outside one: each is Sigvara's own, the slash drill's, or the simulation's. So these figures describe the simulation, not the score in use, and they will mean something only once outside agents are scored.</p>`;
    } else {
      html += `<p class="netnote">${n(r.outside)} of the ${n(r.active)} Active agents ${r.outside === 1 ? "is an outside one" : "are outside ones"}. The rest are Sigvara's own, the slash drill's, or the simulation's, and are counted here too, so for now these figures mostly describe the simulation.</p>`;
    }

    const m = r.matured;
    html += `<h3>How the scores spread now</h3>`;
    html += `<p class="netnote">The matured score of each Active agent, read from the chain: the one a threshold is checked against (<code>getTotalScore</code>).</p>`;
    html += `<div class="ex-scroll"><table class="ex-table"><thead><tr><th>Band</th><th>Agents</th><th>Share</th></tr></thead><tbody>`;
    m.counts.forEach((c, i) => { html += `<tr><td>${bandLabel(i)}</td><td class="num">${n(c)}</td><td class="num">${m.agents ? pct(c / m.agents) : "none"}</td></tr>`; });
    html += `</tbody></table></div>`;
    html += m.agents
      ? `<p class="netnote">Spread: <strong>${bits(m.bits)}</strong> of a possible ${bits(m.maxBits)} bits. The fullest band, ${bandLabel(m.top)}, holds ${pct(m.topShare)} of the agents. A threshold set inside a band all agents share separates nobody: at 0 bits a check tells a counterparty nothing it did not already know.</p>`
      : `<p class="netnote">No Active agent to count.</p>`;

    html += `<h3>Day by day</h3>`;
    html += `<p class="netnote">The earned score each agent had at the end of each UTC day, from the score writes in the event index. Moved counts the agents that ended the day in another band than they started it in.</p>`;
    html += `<div class="ex-scroll"><table class="ex-table"><thead><tr><th>Day</th><th>Agents</th><th>Spread (bits)</th><th>Fullest band</th><th>Moved</th></tr></thead><tbody>`;
    for (const d of r.series.slice().reverse()) {
      html += `<tr><td>${day(d.day)}</td><td class="num">${n(d.agents)}</td><td class="num">${bits(d.bits)}</td><td>${d.agents ? `${bandLabel(d.top)} (${pct(d.topShare)})` : "none"}</td><td class="num">${n(d.moved)} of ${n(d.compared)}</td></tr>`;
    }
    html += `</tbody></table></div>`;

    const c = r.calibration;
    html += `<h3>What followed a score</h3>`;
    if (!c.days) {
      html += `<p class="netnote">No day is ${c.windowDays} days old yet, so nothing can be counted.</p>`;
    } else {
      html += `<p class="netnote">Each agent's earned score at the end of each day from ${day(c.firstEnd - DAY)} to ${day(c.lastEnd - DAY)}, against what happened to that agent in the ${c.windowDays} days after. The newest ${c.windowDays} days are left out, because their window has not run. A score that predicts something has a falling share from the lowest band to the highest. A flat one predicts nothing.</p>`;
      html += `<div class="ex-scroll"><table class="ex-table"><thead><tr><th>Band</th><th>Agent-days</th><th>Then slashed, or a payer said not delivered</th><th>Share</th><th>Then accused</th><th>Then started a withdrawal</th></tr></thead><tbody>`;
      c.rows.forEach((row, i) => {
        html += `<tr><td>${bandLabel(i)}</td><td class="num">${n(row.agentDays)}</td><td class="num">${n(row.bad)}</td><td class="num">${row.agentDays ? pct(row.bad / row.agentDays) : "none"}</td><td class="num">${n(row.accused)}</td><td class="num">${n(row.withdrew)}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }
    const a = r.against, all = a.own + a.outside;
    if (all === 0) html += `<p class="netnote">No agent has been slashed, accused or reported "not delivered" yet.</p>`;
    else if (r.simUnknown) html += `<p class="netnote">${n(all)} slashes, accusations and "not delivered" reports so far.</p>`;
    else if (a.outside === 0) {
      const which = all === 1 ? 'The one slash, accusation or "not delivered" report so far was'
        : `All ${n(all)} slashes, accusations and "not delivered" reports so far were`;
      html += `<p class="netnote">${which} against Sigvara's own agents or the simulation's, staged by the slash drill or the simulation, so this table grades those scripts, not the model.</p>`;
    }
    else html += `<p class="netnote">${n(a.outside)} of the ${n(all)} slashes, accusations and "not delivered" reports so far were against outside agents. The rest were staged by the slash drill or the simulation.</p>`;
    if (c.rows.reduce((s, row) => s + row.bad, 0) < 30) {
      html += `<p class="netnote">At numbers this small a share is a handful of events, not a rate to rely on. The table is here so that the history exists by the time outside agents give it something to measure.</p>`;
    }
    html += r.payer.error
      ? `<p class="pill-warn">The primary oracle's payer outcomes could not be read (${X.esc(r.payer.error)}), so a payer's "not delivered" is not counted above.</p>`
      : `<p class="netnote">Payer outcomes: ${n(r.payer.read)} read from <a href="${X.PRIMARY}/outcomes" target="_blank" rel="noopener">the primary oracle</a>, ${n(r.notDelivered)} of them "not delivered"${r.payer.complete ? "" : `. It has more than this page reads (${n(OUTCOME_PAGES)} pages), so the newest are not counted`}.</p>`;
    return html + notes;
  }

  async function load() {
    const body = document.querySelector("#scoresCard .card-body");
    try {
      const data = await readAll();
      const notes = [data.reputation, data.staking].map(X.historyNote).filter(Boolean).join("");
      body.innerHTML = render(build(data, Math.floor(Date.now() / 1000)), notes);
    } catch (e) {
      body.innerHTML = X.failed("the scores", e);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { BANDS, bandOf, entropyBits, spread, scoreWrites, scoresAt, dailySeries, chainOutcomes, payerNegatives, calibration, readAll, build, render };
  }
  if (typeof document !== "undefined" && document.getElementById("scoresCard")) load();
})(typeof window !== "undefined" ? window : globalThis);
