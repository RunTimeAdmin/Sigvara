"use strict";
// Simulation: Sigvara's labelled testnet simulation at a glance (docs/simulation.md).
//
// Reads three things and nothing else: the published list of every address the simulation
// controls (simulation.json, beside this page), the contracts over the public RPC (status, score,
// stake, slash proposals), and the primary oracle's evidence for each agent (its payments). It
// needs no explorer index, so it loads quickly and is not held back by the explorer's rate limit.

const X = window.SigvaraExplorer;
const $ = (id) => document.getElementById(id);
const DAYS = 28;
// Which batch the page shows: the first unless the address asks for the second (?batch=2).
const BATCH = new URLSearchParams(location.search).get("batch") === "2" ? 2 : 1;

// What happens on which day: mirrors sim/src/plan.mjs and docs/simulation.md. The committee files
// the slashes by hand, so the day a slash can execute depends on when it was filed.
const MILESTONES_1 = [
  { day: 0, title: "Start", text: "Thirteen agents register and bond. Customers start paying the next hour." },
  { day: 3, title: "Sybil ring starts", text: "Three ring agents bond, and six wallets their operator funds start paying them." },
  { day: 7, title: "A new agent arrives", text: "Late arrivals show how tenure counts." },
  { day: 10, title: "First slash filed", text: "The committee slashes the first ring agent. Nobody disputes it. A new agent also arrives." },
  { day: 12, title: "Second slash, disputed", text: "The committee slashes the second ring agent. Its operator disputes, and the admin rules." },
  { day: 14, title: "A new agent arrives", text: "" },
  { day: 17, title: "First slash can be executed", text: "About seven days after filing, the challenge window closes and the simulation executes it." },
  { day: 18, title: "The last new agent arrives", text: "" },
  { day: 28, title: "End", text: "The simulation stops by itself. Agents keep their scores." },
];
// The second batch's days: mirrors sim/src/batch2/plan.mjs.
const MILESTONES_2 = [
  { day: 0, title: "Start", text: "Eleven agents register and bond. Customers on Arc and on Base Sepolia start paying the next hour." },
  { day: 1, title: "ERC-8004 links", text: "The three reviewed agents get ERC-8004 identities that name them." },
  { day: 2, title: "Eight agents at once", text: "Eight agents register and bond on the same day." },
  { day: 3, title: "A second ring", text: "Three ring agents bond. Their customers are funded through a hub wallet and also buy from honest agents." },
  { day: 4, title: "A future operator buys", text: "The wallet that will take over the handover agent pays it as a customer, through day 8." },
  { day: 6, title: "An agent leaves its bond", text: "The bonding agent suspends itself and withdraws its whole bond." },
  { day: 9, title: "Handover and return", text: "The handover agent changes operator. The bonding agent bonds again and is Active." },
  { day: 10, title: "Operators pay their own agent", text: "The former and the new operator pay the handover agent every day. Neither payment should count." },
  { day: 21, title: "Reviewers pay", text: "Six first-batch agents, now over 30 days old, are funded and pay the reviewed agents." },
  { day: 22, title: "Reviews posted", text: "They rate the reviewed agents on ERC-8004. Five share a funder; the sixth was funded by the reviewed agents' operator." },
  { day: 28, title: "End", text: "The batch stops by itself. Agents keep their scores." },
];
const MILESTONES = BATCH === 2 ? MILESTONES_2 : MILESTONES_1;
// The four kinds of simulated agent, in the order they are shown.
const KINDS_1 = [
  { key: "steady", label: "Steady", expect: "Deliver about 95% of jobs. Their scores should climb week by week." },
  { key: "mediocre", label: "Mediocre", expect: "Deliver about 70%. Their scores should settle in the middle." },
  { key: "failing", label: "Failing", expect: "Deliver about 30%. Customers drift away, so their scores should stall." },
  { key: "ring", label: "Sybil ring", expect: "Paid only by wallets their own operator funds. Per-payer caps should limit what that buys, and two of them are slashed." },
];
// The second batch's groups. `pill` borrows a first-batch colour.
const KINDS_2 = [
  { key: "base", pill: "steady", label: "Paid on Base", expect: "Paid only in USDC on Base Sepolia, settled the way x402 settles. Their scores should climb like any steady agent's." },
  { key: "dual", pill: "steady", label: "Paid on both", expect: "Paid in SVR on Arc and in USDC on Base Sepolia. Payments on both chains should count." },
  { key: "handover", pill: "mediocre", label: "Handover", expect: "Changes operator on day 9. Payments from its former and its new operator after that should not count." },
  { key: "bonding", pill: "mediocre", label: "Leaves and returns", expect: "Withdraws its whole bond on day 6 and bonds again on day 9." },
  { key: "burst", pill: "steady", label: "Burst", expect: "Eight agents registering on one day, delivering about 85% of jobs." },
  { key: "reviewed", pill: "steady", label: "Reviewed", expect: "Linked to ERC-8004 and rated on day 22. The five reviewers that share a funder should count as one, and the sixth not at all." },
  { key: "ring2", pill: "ring", label: "Ring 2", expect: "Paid mostly by wallets funded through its operator's hub, at ordinary prices. Per-payer caps should limit what that buys, as with the first ring." },
];
const KINDS = BATCH === 2 ? KINDS_2 : KINDS_1;
const SLASH_STATE = ["none", "pending", "executed", "cancelled", "disputed"];

const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function setCard(id, html) {
  $(id).querySelector(".card-body").innerHTML = html;
  $(id).classList.remove("u-hidden");
  widths($(id));
}
// The site's policy forbids inline style attributes, so bars carry their width as data-w and get
// it here, through the DOM, which the policy allows.
function widths(root) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`;
}

async function load() {
  let sim;
  try {
    sim = await X.getJson("simulation.json");
    if (!Array.isArray(sim?.agents)) throw new Error("it lists no agents");
  } catch (e) {
    return setCard("simHero", `<p>No simulation is published on this site yet (${X.esc(e.message)}).</p>`);
  }
  showBatch();
  const agents = sim.agents.filter((a) => X.isAddr(a?.address) && X.isHash(a?.didHash) && (Number(a.batch) || 1) === BATCH).map((a) => ({
    address: a.address, didHash: a.didHash.toLowerCase(), profile: String(a.profile), day: Number(a.day), operator: String(a.operator ?? ""),
  }));

  // The chain: status and registration time, score, stake, and any slash proposal.
  try {
    const reads = await X.ethCalls(agents.flatMap((a) => [
      { to: X.IDENTITY,   data: X.SEL.identities       + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.getTotalScore    + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.getEarnedScore   + X.pad32(a.didHash) },
      { to: X.STAKING,    data: X.SEL.getStake         + X.pad32(a.didHash) },
      { to: X.STAKING,    data: X.SEL.getSlashProposal + X.pad32(a.didHash) },
    ]));
    agents.forEach((a, i) => {
      const [ident, total, earned, stake, slash] = reads.slice(i * 5, i * 5 + 5);
      a.registeredAt = Number(BigInt(X.word(ident, 4)));
      a.status = a.registeredAt ? Number(BigInt(X.word(ident, 3))) : null;
      a.total = Number(BigInt(total));
      a.earned = Number(BigInt(earned));
      a.stake = BigInt(stake);
      // getSlashProposal returns a struct with a bytes field, so it starts with an offset word:
      // didHash, reporter, victim, initiatedAt and state follow, then the evidence's offset.
      a.slash = SLASH_STATE[Number(BigInt(X.word(slash, 5)))] ?? "none";
    });
  } catch (e) {
    return setCard("simHero", X.failed("the simulated agents from the chain", e));
  }

  // The run started in the hour its day-0 agents registered (sim/src/run.mjs).
  const first = agents.filter((a) => a.day === 0 && a.registeredAt).map((a) => a.registeredAt);
  const start = first.length ? Math.floor(Math.min(...first) / 3600) * 3600 : null;
  renderHero(agents, start, null);
  renderTimeline(start);
  renderCast(agents, start);

  // The oracle's evidence for each registered agent: its payments and signed outcomes. A few at a
  // time, since each is a separate request.
  const live = agents.filter((a) => a.registeredAt);
  for (let i = 0; i < live.length; i += 3) {
    await Promise.all(live.slice(i, i + 3).map(async (a) => {
      try {
        const j = await X.getJson(`${X.PRIMARY}/evidence/${a.didHash}`);
        const list = (Array.isArray(j?.evidence) ? j.evidence : []).filter((e) => e && typeof e === "object");
        a.payments = list.length;
        // Test SVR on this chain only: a payment chain's amounts are in another asset (ADR 0009).
        a.paid = list.filter((e) => e.chainId == null).reduce((s, e) => { try { return s + BigInt(e.amount); } catch (_) { return s; } }, 0n);
        a.signed = list.filter((e) => e.outcomeSource === "payer_signed").length;
        a.onBase = list.filter((e) => e.chainId != null).length;
      } catch (_) { a.payments = null; }
    }));
  }
  renderHero(agents, start, live);
  renderCast(agents, start);
}

function renderHero(agents, start, live) {
  const now = Date.now() / 1000;
  const day = start === null ? null : Math.max(0, Math.floor((now - start) / 86400));
  const done = start !== null && day >= DAYS;
  const pct = start === null ? 0 : Math.min(100, ((now - start) / (DAYS * 86400)) * 100);
  const bonded = agents.filter((a) => a.registeredAt && a.stake > 0n).length;
  const counted = live ? live.filter((a) => a.payments !== null) : [];
  const payments = counted.reduce((s, a) => s + a.payments, 0);
  const paid = counted.reduce((s, a) => s + a.paid, 0n);
  const signed = counted.reduce((s, a) => s + a.signed, 0);
  const onBase = counted.reduce((s, a) => s + a.onBase, 0);
  const pending = live === null;
  const tile = (value, label, sub) => `<div class="sim-tile"><div class="sim-tile-value">${value}</div><div class="sim-tile-label">${label}</div>${sub ? `<div class="sim-tile-sub">${sub}</div>` : ""}</div>`;
  const progress = start === null
    ? '<p class="sim-day">Not started yet</p>'
    : `<div class="sim-day-row"><p class="sim-day">${done ? "Finished" : `Day <b>${day + 1}</b> of ${DAYS}`}</p><p class="sim-dates">${X.esc(fmtDay(start))} to ${X.esc(fmtDay(start + DAYS * 86400))}</p></div>
       <div class="sim-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Progress through the four weeks"><div class="sim-fill" data-w="${pct.toFixed(1)}"></div></div>`;
  $("simHero").querySelector(".card-body").innerHTML = progress + `<div class="sim-tiles">
    ${tile(`${bonded}<span class="sim-of"> / ${agents.length}</span>`, "agents bonded", "the rest arrive later")}
    ${tile(pending ? "…" : payments.toLocaleString("en-US"), "payments", "from simulated customers")}
    ${BATCH === 2
      ? tile(pending ? "…" : onBase.toLocaleString("en-US"), "on Base Sepolia", "of those payments, in test USDC")
      : tile(pending ? "…" : X.esc(X.fmtSvr(paid).replace(" SVR", "")), "SVR paid", "testnet tokens, no value")}
    ${tile(pending ? "…" : signed.toLocaleString("en-US"), "signed outcomes", "customers confirming delivery")}
  </div>`;
  widths($("simHero"));
}

function renderTimeline(start) {
  const now = Date.now() / 1000;
  const today = start === null ? -1 : (now - start) / 86400;
  const nextDay = MILESTONES.find((m) => m.day > today)?.day;
  setCard("timelineCard", `<ol class="sim-timeline">${MILESTONES.map((m) => {
    const state = m.day <= today ? "done" : m.day === nextDay ? "next" : "later";
    const when = start === null ? `Day ${m.day}` : `Day ${m.day} · ${fmtDay(start + m.day * 86400)}`;
    const tag = state === "done" ? "Done" : state === "next" ? "Next" : "";
    return `<li class="sim-step ${state}"><span class="sim-dot" aria-hidden="true"></span>
      <div><div class="sim-step-head"><b>${X.esc(m.title)}</b>${tag ? `<span class="sim-tag ${state}">${tag}</span>` : ""}</div>
      <div class="sim-step-when">${X.esc(when)}</div>${m.text ? `<p>${X.esc(m.text)}</p>` : ""}</div></li>`;
  }).join("")}</ol>`);
}

function statusOf(a, start) {
  if (!a.registeredAt) {
    const when = start === null ? `day ${a.day}` : fmtDay(start + a.day * 86400);
    return ["waiting", `Arrives ${when}`];
  }
  if (a.slash === "executed" || a.status === 2) return ["slashed", "Slashed"];
  if (a.slash === "disputed") return ["warn", "Slash disputed"];
  if (a.slash === "pending") return ["warn", "Slash pending"];
  // After the slash checks, since a slash proposal also suspends its agent and says more. A stake
  // alone does not make an agent Active: Suspended keeps its stake, and PendingBond may hold part of one.
  if (a.status === 1) return ["warn", "Suspended"];
  if (a.status === 3 || a.stake === 0n) return ["waiting", "Not bonded yet"];
  return ["live", "Active"];
}

function renderCast(agents, start) {
  const maxEarned = Math.max(10, ...agents.map((a) => a.earned || 0));
  setCard("castCard", `<div class="sim-legend">${KINDS.map((k) => `<span class="ex-pill ${k.pill ?? k.key}">${X.esc(k.label)}</span>`).join("")}</div>`
    + KINDS.map((k) => {
      const list = agents.filter((a) => a.profile === k.key).sort((x, y) => y.earned - x.earned || x.day - y.day);
      if (!list.length) return "";
      return `<section class="sim-kind ${k.pill ?? k.key}">
        <div class="sim-kind-head"><span class="ex-pill ${k.pill ?? k.key}">${X.esc(k.label)}</span><span class="sim-kind-count">${plural(list.length, "agent")}</span></div>
        <p class="sim-kind-expect">${X.esc(k.expect)}</p>
        <ul class="sim-agents">${list.map((a) => {
          const [cls, text] = statusOf(a, start);
          const width = Math.round(((a.earned || 0) / maxEarned) * 100);
          const pays = !a.registeredAt ? "not yet" : a.payments === undefined ? "…" : a.payments === null ? "?" : plural(a.payments, "payment");
          return `<li>
            <a class="sim-agent" href="epochs?a=${a.address}"><code>${X.short(a.address)}</code></a>
            <span class="sim-status ${cls}">${X.esc(text)}</span>
            <span class="sim-score" title="Earned score ${a.earned}; the score other contracts read is ${a.total}">
              <span class="sim-bar"><span data-w="${width}"></span></span>
              <span class="sim-score-num"><b>${a.earned}</b><span class="sim-of"> earned</span></span>
            </span>
            <span class="sim-pays">${pays}</span>
          </li>`;
        }).join("")}</ul>
      </section>`;
    }).join("")
    + '<p class="netnote">The bar is the earned score, the one last finalized. The score other contracts read climbs toward it slowly; hover a bar for both. Each address opens that agent\'s score epochs.</p>');
}

// The batch switch, the cast's subtitle and the list of what to look for follow the batch shown.
function showBatch() {
  for (const a of document.querySelectorAll("[data-batch]")) {
    if (Number(a.dataset.batch) === BATCH) a.setAttribute("aria-current", "page");
  }
  if (BATCH !== 2) return;
  $("castSub").textContent = "Twenty-two simulated agents in seven groups, each driving a path the first batch does not.";
  $("watchCard").classList.add("u-hidden");
  $("watchCard2").classList.remove("u-hidden");
}

load();
