"use strict";
// Agents: every agent registered on this deployment, its score and stake, and a check of the
// evidence behind its score that runs in the visitor's browser. Sources are in explorer.js.

const X = window.SigvaraExplorer;
const Lobby = window.SigvaraLobby;
const $ = (id) => document.getElementById(id);

const KNOWN_AGENTS = X.KNOWN_AGENTS;
// keccak256("Transfer(address,address,uint256)"), the ERC-20 event a payment settles with.
const TRANSFER_TOPIC = window.SigvaraDid.keccak256(window.SigvaraDid.utf8("Transfer(address,address,uint256)"));
// The newest payments checked against the chain in one go, so one click never sends the
// public RPC more than a few small batches.
const CHAIN_CHECK_LIMIT = 40;

function setCard(id, html) {
  $(id).querySelector(".card-body").innerHTML = html;
  $(id).classList.remove("u-hidden");
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---- the list ----
let agents = [];

async function loadAgents() {
  setCard("agentsCard", X.READING_HISTORY);
  let registrations;
  try {
    [registrations] = await Promise.all([X.contractLogs(X.IDENTITY, ["AgentRegistered"]), X.loadSimulation()]);
  } catch (e) {
    return setCard("agentsCard", X.failed("the registrations from the explorer", e)
      + `<p class="netnote">You can look an agent up by address on <a href="epochs">the epochs page</a>, which reads the chain directly.</p>`);
  }
  const seen = new Set();
  agents = registrations.logs
    .map((l) => ({ didHash: l.topics[1], address: X.topicAddr(l.topics[3]), time: l.time, tx: l.tx }))
    .filter((a) => X.isHash(a.didHash) && X.isAddr(a.address) && !seen.has(a.didHash) && seen.add(a.didHash));
  if (!agents.length) return setCard("agentsCard", "<p>No agent has registered on this deployment yet.</p>");

  try {
    const reads = await X.ethCalls(agents.flatMap((a) => [
      { to: X.IDENTITY,   data: X.SEL.identities     + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.getTotalScore  + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.getEarnedScore + X.pad32(a.didHash) },
      { to: X.REPUTATION, data: X.SEL.evidenceRoots  + X.pad32(a.didHash) },
      { to: X.STAKING,    data: X.SEL.getStake       + X.pad32(a.didHash) },
    ]));
    agents.forEach((a, i) => {
      const [ident, total, earned, root, stake] = reads.slice(i * 5, i * 5 + 5);
      // The operator now, which a transfer can change since registration.
      a.operator = X.wordAddr(ident, 0);
      a.status = Number(BigInt(X.word(ident, 3)));
      a.total = Number(BigInt(total));
      a.earned = Number(BigInt(earned));
      a.root = X.word(root, 0).toLowerCase();
      a.stake = BigInt(stake);
    });
  } catch (e) {
    return setCard("agentsCard", X.failed("the agents' scores from the chain", e));
  }
  renderAgents(registrations);
  renderLobby();
}

// Which group an agent is in, for the badge and the filter.
function groupOf(a) {
  const profile = X.simAgent(a.address);
  if (profile) return { key: "sim", kind: profile, profile, label: `Simulated · ${profile === "ring" ? "Sybil ring" : profile}` };
  if (KNOWN_AGENTS[a.didHash]) return { key: "own", kind: "demo", label: KNOWN_AGENTS[a.didHash] };
  if (X.same(a.operator, X.DEPLOYER)) return { key: "own", kind: "own", label: "Sigvara's own" };
  if (X.same(a.operator, X.DRILL_OPERATOR)) return { key: "own", kind: "drill", label: "Sigvara's slash drill" };
  // Without the simulation's list, any other agent may be one of its, so none is called outside.
  if (X.simUnknown()) return { key: "outside", kind: "outside", label: "Outside or simulated" };
  return { key: "outside", kind: "outside", label: "Outside" };
}
// What the lobby draws an agent from. Its score stays out of this on purpose (lobby.js).
function characterOf(a) {
  const g = groupOf(a);
  return {
    address: a.address,
    kind: g.kind,
    simulated: g.key === "sim",
    mood: a.status === 2 ? "ghost" : a.status === 1 ? "asleep" : "awake",
    waiting: a.status === 3,
  };
}
let filter = "all";
let lastHistory = null;

// The committed root, linked to the payments it is over as the primary oracle serves them, which
// "Check evidence" rebuilds it from.
const rootLink = (a) => (X.same(a.root, X.ZERO32) ? X.rootCode(a.root)
  : `<a href="${X.PRIMARY}/evidence/${a.didHash}" target="_blank" rel="noopener" title="${X.esc(a.root)}: the payments behind it, from the primary oracle"><code>${X.esc(X.short(a.root))}</code></a>`);

function renderAgents(history = lastHistory) {
  lastHistory = history;
  const sorted = [...agents].sort((a, b) => b.total - a.total || b.earned - a.earned || a.time - b.time);
  const count = (key) => agents.filter((a) => groupOf(a).key === key).length;
  const n = { all: agents.length, outside: count("outside"), sim: count("sim"), own: count("own") };
  const active = agents.filter((a) => a.status === 0).length;
  let html = `<p><b>${plural(agents.length, "agent")}</b> registered on this deployment, ${active} active.`
    + (n.sim ? ` <b>${n.sim}</b> of them are Sigvara's <a href="simulation">testnet simulation</a>, which runs a simulated economy so the protocol can be watched working.` : "")
    + ` Both oracle operators are run by the Sigvara team (see <a href="operators">Operators</a>), so read these scores as the protocol working, not as outside demand.</p>`;
  if (X.simUnknown()) html += '<p class="pill-warn">The list of the testnet simulation\'s agents could not be read, so this page cannot tell its agents from outside ones. Reload to try again.</p>';
  const choices = [["all", "All"], ["outside", "Outside"], ["sim", "Simulated"], ["own", "Sigvara's own"]].filter(([k]) => k === "all" || n[k]);
  html += `<div class="ex-filter" role="group" aria-label="Show agents">${choices.map(([k, label]) =>
    `<button type="button" data-filter="${k}" aria-pressed="${filter === k}">${X.esc(label)} (${n[k]})</button>`).join("")}</div>`;
  const shown = sorted.filter((a) => filter === "all" || groupOf(a).key === filter);
  html += `<div class="ex-scroll"><table class="ex-table">
    <thead><tr><th>Agent</th><th>Who</th><th>Status</th><th title="getTotalScore: the score other contracts read, which matures toward the earned score">Matured score</th><th title="getEarnedScore: the score as last finalized">Earned</th><th>Stake</th><th>Evidence root</th><th></th></tr></thead><tbody>`;
  for (const a of shown) {
    const g = groupOf(a);
    const pillClass = g.key === "sim" ? g.profile : g.key;
    html += `<tr>
      <td><div class="ag-cell">${Lobby.svg(characterOf(a), 30)}<div><a href="epochs?a=${a.address}"><code>${X.short(a.address)}</code></a><div class="ex-note">${X.esc(Lobby.nickname(a.address))}</div></div></div></td>
      <td><span class="ex-pill ${X.esc(pillClass)}">${X.esc(g.label)}</span><div class="ex-note">operator ${X.whoIs(a.operator)}</div></td>
      <td>${X.esc(X.STATUS[a.status] ?? "?")}</td>
      <td><b>${a.total}</b></td>
      <td>${a.earned}</td>
      <td class="num">${X.esc(X.fmtSvr(a.stake))}</td>
      <td>${rootLink(a)}</td>
      <td><button class="btn btn-secondary btn-sm" type="button" data-check="${a.didHash}">Check evidence</button></td>
    </tr>`;
  }
  html += "</tbody></table></div>";
  html += '<p class="netnote">The matured score is the total other contracts read (<code>getTotalScore</code>). It climbs toward the earned score, the one last finalized (<code>getEarnedScore</code>), at a bounded rate a day, and falls at once. <a href="docs/reputation">How scores work</a>. The agent links open its score epochs, and each evidence root links to the payments it commits to.</p>';
  if (history?.truncated) html += '<p class="pill-warn">The explorer has more registrations than this page reads, so the newest may be missing.</p>';
  html += X.historyNote(history);
  setCard("agentsCard", html);
  for (const btn of document.querySelectorAll("[data-check]")) {
    btn.addEventListener("click", () => checkEvidence(btn.getAttribute("data-check")));
  }
  for (const btn of document.querySelectorAll("[data-filter]")) {
    btn.addEventListener("click", () => { filter = btn.getAttribute("data-filter"); renderAgents(); });
  }
}

// ---- the lobby ----
function renderLobby() {
  $("lobbyCard").classList.remove("u-hidden");
  Lobby.startLobby($("lobbyRoom"), agents.map((a) => ({ ...characterOf(a), agent: a })), (person) => showInLobby(person.agent));
}

function showInLobby(a) {
  const g = groupOf(a);
  const pillClass = g.key === "sim" ? g.profile : g.key;
  $("lobbyPick").innerHTML = `${Lobby.svg(characterOf(a), 72)}
    <div>
      <div class="ag-name">${X.esc(Lobby.nickname(a.address))}</div>
      <a href="epochs?a=${a.address}"><code>${X.esc(a.address)}</code></a>
      <dl>
        <dt>Who</dt><dd><span class="ex-pill ${X.esc(pillClass)}">${X.esc(g.label)}</span></dd>
        <dt>Status</dt><dd>${X.esc(X.STATUS[a.status] ?? "?")}</dd>
        <dt>Matured score</dt><dd>${a.total}</dd>
        <dt>Earned</dt><dd>${a.earned}</dd>
        <dt>Stake</dt><dd>${X.esc(X.fmtSvr(a.stake))}</dd>
      </dl>
    </div>
    <button class="btn btn-secondary btn-sm" type="button" id="lobbyCheck">Check evidence</button>`;
  $("lobbyCheck").addEventListener("click", () => checkEvidence(a.didHash));
}

// ---- the evidence check ----
let checkSeq = 0;

async function checkEvidence(didHash) {
  const seq = ++checkSeq;
  const a = agents.find((x) => x.didHash === didHash);
  if (!a) return;
  setCard("checkCard", `<p class="netnote">Reading the payments behind <code>${X.short(a.address)}</code>…</p>`);
  $("checkCard").scrollIntoView({ behavior: "smooth", block: "start" });
  const [evidence, pending] = await Promise.allSettled([
    X.getJson(`${X.PRIMARY}/evidence/${didHash}`),
    X.ethCalls([{ to: X.REPUTATION, data: X.SEL.getPendingScore + X.pad32(didHash) }]),
  ]);
  if (seq !== checkSeq) return;
  try {
    await renderCheck(a, evidence, pending);
  } catch (e) {
    setCard("checkCard", X.failed("this check", e));
  }
}

async function renderCheck(a, evidence, pendingRead) {
  const seq = checkSeq;
  const head = `<p>Agent ${KNOWN_AGENTS[a.didHash] ? `${X.esc(KNOWN_AGENTS[a.didHash])}, ` : ""}<a href="epochs?a=${a.address}"><code>${X.esc(a.address)}</code></a>.</p>`;
  if (evidence.status === "rejected") return setCard("checkCard", head + X.failed("the primary oracle's evidence", evidence.reason));
  const j = evidence.value;
  const list = (Array.isArray(j?.evidence) ? j.evidence : []).filter((e) => e && typeof e === "object");
  const served = X.isHash(j?.evidenceRoot) ? j.evidenceRoot.toLowerCase() : null;
  // How long after settling a payment chain's payment enters a score (ADR 0009), by chain id.
  const delays = Object.fromEntries((Array.isArray(j?.paymentChains) ? j.paymentChains : [])
    .filter((c) => c && Number.isSafeInteger(c.chainId)).map((c) => [c.chainId, Number(c.delaySeconds) || 0]));
  const evidenceCut = j?.evidenceCut && typeof j.evidenceCut === "object" ? j.evidenceCut : null;

  // 1. Rebuild every leaf from its fields, never from the leaf the oracle served.
  const rebuilt = [], bad = [];
  list.forEach((e, i) => {
    try { rebuilt.push(X.leafOf(e)); } catch (err) { bad.push(`payment ${i + 1}: ${err.message}`); rebuilt.push(null); }
  });
  const leafDiffs = list.filter((e, i) => rebuilt[i] && X.isHash(e.leaf) && !X.same(e.leaf, rebuilt[i])).length;
  const rows = [];
  rows.push(["Payments listed", `${list.length}, by the primary oracle's <a href="${X.PRIMARY}/evidence/${a.didHash}" target="_blank" rel="noopener">evidence endpoint</a>`]);
  if (bad.length) {
    rows.push(["Rebuilt", `<span class="pill-err">${plural(bad.length, "payment")} cannot be part of any root</span> ${X.esc(bad.slice(0, 3).join("; "))}`]);
  } else {
    const root = X.rootOf(rebuilt);
    rows.push(["Root rebuilt here", `${X.rootCode(root)} ${served === null ? "" : X.same(root, served)
      ? '<span class="pill-ok">matches the root the oracle serves</span>'
      : `<span class="pill-err">differs from the root the oracle serves (${X.rootCode(served)})</span>`}`]);
    if (leafDiffs) rows.push(["Served leaves", `<span class="pill-err">${plural(leafDiffs, "leaf", "leaves")} the oracle served ${leafDiffs === 1 ? "does" : "do"} not match the payment ${leafDiffs === 1 ? "it was" : "they were"} served with</span>`]);
  }

  // 2. The roots committed on chain: the finalized one, and a pending proposal's.
  let finalHtml, pendingHtml = null, confirmJob = null;
  if (bad.length) {
    finalHtml = "not checked, because the list above has payments that cannot be rebuilt";
  } else if (X.same(a.root, X.ZERO32)) {
    finalHtml = "none yet: no score with an evidence root has been finalized for this agent";
  } else {
    const m = X.matchRoot(list, a.root, { delays });
    if (!m) {
      finalHtml = `${X.rootCode(a.root)} <span class="pill-err">no reading of these payments reproduces it</span>. The oracle no longer lists the set this score was made on, or lists it differently.`;
    } else {
      finalHtml = `${X.rootCode(a.root)} <span class="pill-ok">reproduced</span> from ${describeMatch(m, list.length)}`;
      confirmJob = m;
    }
  }
  rows.push(["Finalized root", finalHtml]);
  if (pendingRead.status === "fulfilled") {
    const raw = pendingRead.value[0];
    if (BigInt(X.word(raw, 8)) === 1n) {
      const proposedAt = Number(BigInt(X.word(raw, 7)));
      const root = X.word(raw, 9).toLowerCase();
      const m = bad.length ? null : X.matchRoot(list, root, { at: proposedAt, delays, evidenceCut });
      pendingHtml = `${X.rootCode(root)}, proposed ${X.esc(X.fmtWhen(proposedAt))}: ` + (m
        ? `<span class="pill-ok">reproduced</span> from ${describeMatch(m, list.length)}`
        : '<span class="pill-err">not reproduced</span> from the payments settled by then');
    }
  } else {
    pendingHtml = X.failed("the pending proposal", pendingRead.reason);
  }
  if (pendingHtml) rows.push(["Pending proposal", pendingHtml]);
  rows.push(["Contract check", confirmJob ? '<span class="netnote">Asking the reputation contract…</span>' : "nothing to confirm"]);

  // The card is drawn once. The contract's answer then fills in its own row only, so the result of a
  // payments check started meanwhile, in #chainCheck, stays.
  const contractRow = (html) => { const dd = $("contractCheck"); if (dd) dd.innerHTML = html; };
  const render = (contractHtml) => {
    rows[rows.length - 1] = ["Contract check", contractHtml];
    setCard("checkCard", head + `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="prose"${k === "Contract check" ? ' id="contractCheck"' : ""}>${v}</dd>`).join("")}</dl>`
      + (list.length ? `<p><button class="btn btn-secondary btn-sm" type="button" id="chainCheckBtn">Check the payments against the chain</button></p><div id="chainCheck"></div>` : "")
      + '<p class="netnote">The leaf is <code>keccak256(keccak256(abi.encode(txHash, payer, amount, settledAt, outcome)))</code>, with <code>chainId</code> first for a payment that settled on another chain, the tree hashes sorted pairs, and an odd node is promoted, as in <a href="https://github.com/RunTimeAdmin/Sigvara/blob/main/oracle/merkle.js" target="_blank" rel="noopener">oracle/merkle.js</a>. A test holds this page to it.</p>');
    const btn = $("chainCheckBtn");
    if (btn) btn.onclick = () => checkPayments(a, list);
  };
  render(rows[rows.length - 1][1]);

  // 3. verifyEvidence(didHash, leaf, proof): the contract confirms each payment is in its root.
  if (confirmJob) {
    try {
      const layers = X.layersOf(confirmJob.leaves);
      const answers = await X.ethCalls(confirmJob.leaves.map((leaf, i) => ({
        to: X.REPUTATION, data: X.verifyEvidenceCall(a.didHash, leaf, X.proofOf(layers, i)),
      })));
      if (seq !== checkSeq) return;
      const yes = answers.filter((r) => BigInt(X.word(r, 0)) === 1n).length;
      contractRow(yes === answers.length
        ? `<span class="pill-ok">confirmed</span> <code>verifyEvidence</code> returns true for all ${plural(yes, "payment")} against the root the contract holds`
        : `<span class="pill-err">${yes} of ${answers.length} confirmed</span> by <code>verifyEvidence</code>`);
    } catch (e) {
      if (seq === checkSeq) contractRow(X.failed("the contract's answer", e));
    }
  }
}

function describeMatch(m, of) {
  const what = m.events.length === of ? `all ${plural(of, "payment")} listed` : `${m.events.length} of the ${of} payments listed`;
  const counted = m.events.some((e) => e.chainId != null) ? "counted" : "settled";
  const when = Number.isFinite(m.cut) && m.events.length !== of ? `, the ones ${counted} by ${X.esc(X.fmtWhen(m.cut))}` : "";
  const unset = m.unset ? ", reading each outcome the payer signed afterwards as not yet reported" : "";
  return what + when + unset + ".";
}

// ---- each payment against its transaction ----
async function checkPayments(a, list) {
  const out = $("chainCheck");
  // A payment chain's payment (ADR 0009) is not on this chain, so it is listed and not checked here.
  const elsewhere = list.filter((e) => e.chainId != null);
  const picked = [...list].filter((e) => e.chainId == null)
    .sort((x, y) => Number(y.settledAt) - Number(x.settledAt)).slice(0, CHAIN_CHECK_LIMIT)
    .filter((e) => X.isHash(e.txHash));
  out.innerHTML = `<p class="netnote">Reading ${plural(picked.length, "transaction")} from the chain…</p>`;
  try {
    const receipts = [];
    for (let i = 0; i < picked.length; i += 10) {
      receipts.push(...await X.rpcMany(picked.slice(i, i + 10).map((e) => ["eth_getTransactionReceipt", [e.txHash]])));
    }
    const blocks = [...new Set(receipts.filter((r) => r && r.blockNumber).map((r) => r.blockNumber))];
    const times = new Map();
    for (let i = 0; i < blocks.length; i += 10) {
      const got = await X.rpcMany(blocks.slice(i, i + 10).map((b) => ["eth_getBlockByNumber", [b, false]]));
      got.forEach((b, k) => times.set(blocks[i + k], b ? Number(BigInt(b.timestamp)) : null));
    }
    const results = picked.map((e, i) => ({ e, problem: paymentProblem(a, e, receipts[i], times) }));
    const ok = results.filter((r) => !r.problem).length;
    out.innerHTML = `<p>${ok === results.length
      ? `<span class="pill-ok">All ${plural(ok, "payment")} checked</span> match their transactions`
      : `<span class="pill-err">${results.length - ok} of ${results.length} do not match</span> their transactions`}: a successful transfer of test SVR to the agent from the listed payer, for the listed amount, in a block with the listed time.`
      + (list.length - elsewhere.length > picked.length ? ` The newest ${picked.length} of ${list.length - elsewhere.length} were checked.` : "")
      + (elsewhere.length ? ` ${plural(elsewhere.length, "payment")} settled on another chain and ${elsewhere.length === 1 ? "is" : "are"} not checked here.` : "") + "</p>"
      + `<ul class="pay-list">${results.map(({ e, problem }) => `<li>
          <span>${X.esc(X.fmtWhen(Number(e.settledAt)))}</span>
          <span>${X.esc(X.fmtSvr(e.amount))} from ${X.whoIs(e.payer)}</span>
          <span class="${problem ? "pill-err" : "pill-ok"}">${X.esc(problem || "matches")}</span>
          <span>${X.txLink(e.txHash)}</span>
        </li>`).join("")}${elsewhere.slice(0, CHAIN_CHECK_LIMIT).map((e) => `<li>
          <span>${X.esc(X.fmtWhen(Number(e.settledAt)))}</span>
          <span>${X.esc(X.fmtAmount(e))} from ${X.paymentPayerLink(e)}</span>
          <span>not checked here</span>
          <span>${X.paymentTxLink(e)}</span>
        </li>`).join("")}</ul>`;
  } catch (e) {
    out.innerHTML = X.failed("the transactions", e);
  }
}

// What the oracle checks when it takes a payment (oracle/payments.js), from the receipt alone.
function paymentProblem(a, e, receipt, times) {
  if (!receipt) return "no such transaction";
  if (receipt.status !== "0x1") return "the transaction reverted";
  const credits = new Map();
  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
    const t = log?.topics || [];
    if (!X.same(log.address, X.SVR) || !X.same(t[0], TRANSFER_TOPIC) || t.length < 3) continue;
    if (!X.same(X.topicAddr(t[2]), a.address)) continue;
    const from = X.topicAddr(t[1]);
    credits.set(from, (credits.get(from) ?? 0n) + BigInt(log.data));
  }
  if (!credits.size) return "no SVR transfer to the agent";
  const fromPayer = credits.get(String(e.payer).toLowerCase()) ?? 0n;
  if (fromPayer === 0n) return "the listed payer sent nothing";
  const total = [...credits.values()].reduce((s, v) => s + v, 0n);
  const amount = BigInt(e.amount);
  // The oracle counts every sender that paid at least its minimum, so with several senders the
  // listed amount sits between the payer's own transfer and the total.
  if (amount !== fromPayer && amount !== total && !(credits.size > 1 && amount > fromPayer && amount <= total)) {
    return "a different amount";
  }
  const at = times.get(receipt.blockNumber);
  if (at !== Number(e.settledAt)) return "a different settlement time";
  return null;
}

loadAgents();
