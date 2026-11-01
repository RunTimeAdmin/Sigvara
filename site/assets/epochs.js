"use strict";
// Score epochs: every score Sigvara writes for one agent, step by step.
//
// Reads only. No wallet, nothing signed, no external library (see app.js for why).
// Four sources, and the page says which one each fact came from:
//   - the chain, over the public RPC: the finalized score, the pending proposal, the window.
//   - the Arc explorer's log index: the history of proposals, finalizations and rejections.
//     The RPC answers eth_getLogs over at most 10,000 blocks (about 85 minutes) and
//     rate-limits a batch of them, so a week of history would be over a hundred requests.
//     The explorer answers the whole history in one.
//   - the primary oracle: the payments behind the agent's score (/evidence).
//   - the checker: whether its own recomputation disagreed with a proposal (/divergence).
// Everything that comes back is untrusted input: hex is shape-checked before it goes into a
// link, and text is escaped before it goes into the page.

const CHAIN_ID = 5042002;
const RPC = "https://rpc.testnet.arc.io";
const EXPLORER = "https://explorer.testnet.arc.io";
const EXPLORER_API = EXPLORER + "/api";
const PRIMARY = "https://oracle.sigvara.xyz";
const CHECKER = "https://checker.sigvara.xyz";
const SOURCE = "https://github.com/RunTimeAdmin/Sigvara";
// From deployments/5042002.json.
const IDENTITY   = "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd";
const REPUTATION = "0x6603C96275e85F724Cdf74666b399365e4cA29ed";
// The two ORACLE_ROLE holders, read from RoleGranted on the reputation proxy on
// 1 Nov 2026 (none revoked). Only used to name a proposer; any other address is shown bare.
const OPERATORS = {
  "0x6352b8ffbc3bdd182512ce59ef69d1b155fb3943": "primary",
  "0x989aabd69631f81a6b2c8ce508c32aa219ec172d": "checker",
};

// 4-byte selectors, checked against src/ by scripts/check-docs.mjs.
const SEL = {
  identities: "0x81638e9b", getTotalScore: "0x2522be94", getEarnedScore: "0x9d46deb8",
  getPendingScore: "0x56cf76e7", evidenceRoots: "0x42201823", challengeWindow: "0x861a1412",
};
// topic0 of each event this page reads. scripts/check-docs.mjs checks every topic against its
// signature, and every current one against src/SigvaraReputation.sol. The two legacy ones were
// emitted on 18 September 2026, before proposals carried an evidence root; the oldest epochs on
// this deployment use them.
const EVENTS = [
  { name: "ScoreProposed", sig: "ScoreProposed(bytes32,uint256,bytes32)", topic: "0x2ecf59b65d6c5f89b87bffff8937f2a81e253859b6b76bfd7f137c2db9b6caff" },
  { name: "ReputationUpdated", sig: "ReputationUpdated(bytes32,uint8,uint256,bytes32)", topic: "0x3326e60e6a1b323d1c5f9b8de1276b4fe3d90a79f228cc79766b6ada11428e3a" },
  { name: "ScoreRejected", sig: "ScoreRejected(bytes32,address)", topic: "0x8b012328cd002945205e92e9b63d1d289bba30481e9edacae21f2195d2783110" },
  { name: "ReputationZeroed", sig: "ReputationZeroed(bytes32)", topic: "0x70503cbb48ebe74f26e5b96b532e80c13ba04ee396f33ebe1c766877bad61d75" },
  { name: "ScoreProposed", sig: "ScoreProposed(bytes32,uint256)", topic: "0x0f4fc0d3f795b014a93d83c4400d66dc10813958b8b0f11bf69d0b4310cd47f0", legacy: true },
  { name: "ReputationUpdated", sig: "ReputationUpdated(bytes32,uint8,uint256)", topic: "0x741d706ed4c3bf9f21d7f0ba307ed608886278a922287cc099e8e0e5fb5eeeb5", legacy: true },
];
// factor label, on-chain word index, and max: mirrors SigvaraReputation.ReputationData
const FACTORS = [
  ["fee", 0, 20], ["success", 1, 15], ["age", 2, 30],
  ["external", 3, 25], ["community", 4, 5], ["propagation", 5, 5],
];
// Index matches SigvaraIdentity.AgentStatus.
const STATUS = ["Active", "Suspended", "Slashed", "awaiting bond"];
// The explorer's getLogs returns at most this many rows. A full page means there may be more.
const EXPLORER_PAGE = 1000;
// About a day of Arc blocks, at roughly two a second.
const RECENT_BLOCKS = 172800;
const TIMELINE_SHOWN = 25;

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const strip = (h) => h.startsWith("0x") ? h.slice(2) : h;
const pad32 = (h) => strip(h).toLowerCase().padStart(64, "0");
const word = (data, i) => "0x" + strip(data).slice(i * 64, (i + 1) * 64);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const ZERO32 = "0x" + "0".repeat(64);

// ---- formatting ----
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
// Times come from three outside services, and toISOString throws on NaN, which would blank a card.
const fmtWhen = (sec) => Number.isFinite(sec) && sec > 0
  ? new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "an unknown time";
function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "?";
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}
// 18 decimals: the SVR test token, which is what the evidence amounts are in.
function fmtSvr(raw) {
  try {
    const v = BigInt(raw);
    const i = v / 10n ** 18n, f = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
    return (f ? `${i}.${f}` : i.toString()) + " test SVR";
  } catch (_) { return "?"; }
}
const txLink = (h) => isHash(h)
  ? `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener"><code>${short(h)}</code></a>` : "";
const addrLink = (a) => isAddr(a)
  ? `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener"><code>${short(a)}</code></a>` : "?";
const rootCode = (r) => !r ? "none" : r === ZERO32 ? "<code>0x0</code> (no payments)" : `<code title="${esc(r)}">${esc(short(r))}</code>`;
const commitLink = (c) => /^[0-9a-f]{40}$/.test(c || "")
  ? `<a href="${SOURCE}/commit/${c}" target="_blank" rel="noopener"><code>${c.slice(0, 7)}</code></a>` : "unknown";
function operatorName(a) {
  const name = OPERATORS[String(a).toLowerCase()];
  return name ? `the ${name} (${addrLink(a)})` : addrLink(a);
}
const sourceLabel = (s) => s === "payer_signed" ? "signed by the payer" : s === "credentialed" ? "credentialed" : "payment only";

// ---- io ----
async function getJson(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    // The explorer allows ten requests a window from one address, and a lookup uses one or two.
    if (res.status === 429) throw new Error("too many requests from this address just now. Try again in a minute or two");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "timed out" : e.message);
  } finally {
    clearTimeout(t);
  }
}

// Many eth_calls, one request, matched on id (see app.js).
async function rpcBatch(calls) {
  const arr = await getJson(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] }))),
  });
  if (!Array.isArray(arr)) throw new Error(arr?.error?.message ?? "batch call failed");
  const byId = new Map(arr.map(r => [r.id, r]));
  return calls.map((_, i) => {
    const r = byId.get(i);
    if (!r || r.error || typeof r.result !== "string") throw new Error(r?.error?.message ?? "missing result in batch");
    return r.result;
  });
}

async function blockNumber() {
  const j = await getJson(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (typeof j?.result !== "string") throw new Error(j?.error?.message ?? "no block number");
  return Number(BigInt(j.result));
}

// The reputation contract's logs from the explorer, oldest first. A full page is continued from
// its last block, because the explorer has no cursor; rows already seen are dropped.
async function explorerLogs(extra, fromBlock = 0) {
  const out = [], seen = new Set();
  let from = fromBlock, more = false;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ module: "logs", action: "getLogs", address: REPUTATION, fromBlock: String(from), toBlock: "latest", ...extra });
    const j = await getJson(`${EXPLORER_API}?${q}`);
    // "No logs found" comes back as status 0 with an empty result, and is an answer.
    if (!Array.isArray(j?.result)) throw new Error(typeof j?.message === "string" ? j.message : "unexpected answer");
    for (const r of j.result) {
      const key = `${r.transactionHash}:${r.logIndex}`;
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    more = j.result.length >= EXPLORER_PAGE;
    if (!more) break;
    from = parseInt(j.result[j.result.length - 1].blockNumber, 16);
  }
  const logs = out.map(parseLog).filter(Boolean);
  logs.sort((a, b) => a.block - b.block || a.index - b.index);
  return { logs, truncated: more };
}

function parseLog(r) {
  const ev = EVENTS.find(e => e.topic === String(r?.topics?.[0]).toLowerCase());
  if (!ev || typeof r.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.data)) return null;
  const w = (i) => BigInt(word(r.data, i).length > 2 ? word(r.data, i) : "0x0");
  const rootAt = (i) => (ev.legacy ? null : word(r.data, i));
  const log = {
    name: ev.name,
    didHash: String(r.topics[1] || "").toLowerCase(),
    block: parseInt(r.blockNumber, 16),
    index: parseInt(r.logIndex, 16) || 0,
    time: parseInt(r.timeStamp, 16),
    tx: isHash(r.transactionHash) ? r.transactionHash : null,
  };
  if (ev.name === "ScoreProposed") Object.assign(log, { at: Number(w(0)), root: rootAt(1) });
  if (ev.name === "ReputationUpdated") Object.assign(log, { total: Number(w(0)), at: Number(w(1)), root: rootAt(2) });
  if (ev.name === "ScoreRejected") log.committee = "0x" + String(r.topics[2] || "").slice(26);
  if (ev.name === "ReputationZeroed") log.at = log.time;
  return log;
}

// One entry per proposal, oldest first, each with what became of it. A proposal ends when it is
// finalized, rejected, cleared by a slash, or replaced by a newer proposal for the same agent.
function buildEpochs(logs) {
  const epochs = [];
  let open = null;
  const close = (fate) => { if (open) { open.fate = fate; open = null; } };
  for (const l of logs) {
    if (l.name === "ScoreProposed") {
      close({ kind: "replaced", at: l.at, tx: l.tx });
      open = { proposedAt: l.at, root: l.root, tx: l.tx, fate: null };
      epochs.push(open);
    } else if (l.name === "ReputationUpdated") {
      close({ kind: "finalized", at: l.at, total: l.total, root: l.root, tx: l.tx });
    } else if (l.name === "ScoreRejected") {
      close({ kind: "rejected", at: l.time, by: l.committee, tx: l.tx });
    } else if (l.name === "ReputationZeroed") {
      close({ kind: "cleared", at: l.at, tx: l.tx });
      epochs.push({ zeroed: true, at: l.at, tx: l.tx });
    }
  }
  return epochs;
}

// ---- reading the chain ----
function decodePending(raw, challengeWindow) {
  if (BigInt(word(raw, 8)) !== 1n) return null;
  const factors = FACTORS.map(([name, i, max]) => ({ name, value: Number(BigInt(word(raw, i))), max }));
  const proposedAt = Number(BigInt(word(raw, 7)));
  // main stores when a proposal becomes final; a proposal from before that field existed is
  // judged against the window in force now, as the contract does.
  const stored = strip(raw).length >= 12 * 64 ? Number(BigInt(word(raw, 11))) : 0;
  return {
    factors,
    total: factors.reduce((s, f) => s + f.value, 0),
    proposedAt,
    root: word(raw, 9),
    proposer: "0x" + strip(word(raw, 10)).slice(24),
    finalizableAt: stored || proposedAt + challengeWindow,
  };
}

async function readChain(didHash) {
  const [ident, total, earned, pending, root, windowRaw] = await rpcBatch([
    { to: IDENTITY,   data: SEL.identities      + pad32(didHash) },
    { to: REPUTATION, data: SEL.getTotalScore   + pad32(didHash) },
    { to: REPUTATION, data: SEL.getEarnedScore  + pad32(didHash) },
    { to: REPUTATION, data: SEL.getPendingScore + pad32(didHash) },
    { to: REPUTATION, data: SEL.evidenceRoots   + pad32(didHash) },
    { to: REPUTATION, data: SEL.challengeWindow },
  ]);
  const challengeWindow = Number(BigInt(windowRaw));
  return {
    registered: BigInt(word(ident, 4)) !== 0n,
    status: Number(BigInt(word(ident, 3))),
    total: Number(BigInt(total)),
    earned: Number(BigInt(earned)),
    finalRoot: word(root, 0),
    challengeWindow,
    pending: decodePending(pending, challengeWindow),
  };
}

// ---- rendering ----
function setCard(id, html) {
  $(id).querySelector(".card-body").innerHTML = html;
  $(id).classList.remove("u-hidden");
}
const failed = (what, e) => `<p class="pill-err">Could not read ${esc(what)}: ${esc(e?.message ?? e)}.</p>`;

function renderAgent(addr, didHash, chain) {
  $("didStr").textContent = `did:sigvara:${CHAIN_ID}:${addr}`;
  $("didHash").textContent = didHash;
  if (chain.status === "rejected") {
    $("status").innerHTML = failed("the chain", chain.reason);
    $("score").textContent = "unknown";
    $("finalRoot").textContent = "unknown";
  } else {
    const c = chain.value;
    $("status").innerHTML = c.registered ? esc(STATUS[c.status] ?? "?") : '<span class="pill-warn">not registered</span>';
    $("score").innerHTML = `<b>${c.total}</b> / 100 spendable, ${c.earned} earned.`
      + (c.total !== c.earned ? " The spendable score moves toward the earned one over time." : "")
      + ' <a href="docs/reputation">How scores work</a>';
    $("finalRoot").innerHTML = rootCode(c.finalRoot);
  }
  $("agentInfo").classList.remove("u-hidden");
}

function renderPending(chain) {
  if (chain.status === "rejected") return setCard("pendingCard", failed("the chain", chain.reason));
  const p = chain.value.pending, now = Math.floor(Date.now() / 1000);
  if (!p) {
    return setCard("pendingCard", "<p>Nothing is pending. The score above is the last one finalized, and the oracle proposes again when its next epoch finds something to score.</p>");
  }
  const open = now < p.finalizableAt;
  setCard("pendingCard", `
    <dl class="kv">
      <dt>Proposed score</dt><dd><b>${p.total}</b> / 100</dd>
      <dt>Factors</dt><dd>${p.factors.map(f => `${esc(f.name)} ${f.value}/${f.max}`).join(" &nbsp;·&nbsp; ")}</dd>
      <dt>Proposed by</dt><dd class="prose">${operatorName(p.proposer)}</dd>
      <dt>Proposed at</dt><dd>${esc(fmtWhen(p.proposedAt))}</dd>
      <dt>Evidence root</dt><dd>${rootCode(p.root)}</dd>
      <dt>Challenge window</dt><dd class="prose">${open
        ? `<span class="pill-warn">open</span> until ${esc(fmtWhen(p.finalizableAt))} (${esc(fmtDuration(p.finalizableAt - now))} left). Until then the committee can reject it.`
        : `<span class="pill-ok">closed</span> at ${esc(fmtWhen(p.finalizableAt))}. Anyone can call <code>finalizeReputation</code> now, and the oracle does on its next epoch.`}</dd>
    </dl>`);
}

function renderEvidence(didHash, evidence, chain) {
  if (evidence.status === "rejected") return setCard("evidenceCard", failed("the primary oracle's evidence", evidence.reason));
  const j = evidence.value;
  const list = Array.isArray(j?.evidence) ? j.evidence : [];
  const root = isHash(j?.evidenceRoot) ? j.evidenceRoot.toLowerCase() : null;
  const by = (s) => list.filter(e => (e.outcomeSource ?? null) === s).length;
  const c = chain.status === "fulfilled" ? chain.value : null;
  const p = c?.pending;
  const kinds = [[by("payer_signed"), "signed by the payer"], [by("credentialed"), "credentialed"], [by(null), "with no outcome"]]
    .filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");

  let html = `<p>The primary oracle holds <b>${list.length}</b> payment${list.length === 1 ? "" : "s"} for this agent`
    + (kinds ? `: ${kinds}. ` : ". ")
    + `Their Merkle root is ${rootCode(root)}`;
  if (c) {
    if (p && root === p.root.toLowerCase()) html += ", the same root as the pending proposal.";
    else if (!p && root === c.finalRoot.toLowerCase()) html += ", the same root as the finalized score.";
    else if (p) html += `. The pending proposal was made on ${rootCode(p.root)}, a different set of payments.`;
    else html += `. The finalized score was made on ${rootCode(c.finalRoot)}.`;
  } else {
    html += ".";
  }
  html += "</p>";

  if (p) {
    const after = list.filter(e => Number(e.settledAt) > p.proposedAt).length;
    html += `<p>${list.length - after} settled before the pending proposal was made and ${after} after. `
      + "A payment that settled after a proposal cannot be in it; it counts from a later one.</p>";
  }

  const rows = [...list].sort((a, b) => Number(b.settledAt) - Number(a.settledAt)).slice(0, 20);
  if (rows.length) {
    html += '<ul class="pay-list">' + rows.map(e => `<li>
      <span>${esc(fmtWhen(Number(e.settledAt)))}</span>
      <span>${esc(fmtSvr(e.amount))} from ${addrLink(e.payer)}</span>
      <span class="${e.outcomeSource === "payer_signed" ? "pill-ok" : ""}">${esc(sourceLabel(e.outcomeSource))}${e.success === false ? ", failed" : ""}</span>
      <span>${txLink(e.txHash)}</span>
    </li>`).join("") + "</ul>";
    if (list.length > rows.length) html += `<p class="netnote">Newest ${rows.length} of ${list.length} shown.</p>`;
  }
  html += `<p class="netnote">Each payment can be read off the chain by its transaction. The full answer, with Merkle proofs, is at <a href="${PRIMARY}/evidence/${didHash}" target="_blank" rel="noopener">the oracle's evidence endpoint</a>.</p>`;
  setCard("evidenceCard", html);
}

function healthLine(h) {
  if (h.status === "rejected") return failed("its health", h.reason);
  const v = h.value;
  const last = Number(v?.lastSuccessfulEpochMs);
  return `runs ${commitLink(v?.commit)}, one epoch every ${esc(fmtDuration(Number(v?.epochMs) / 1000))}`
    + (last ? `, last epoch at ${esc(fmtWhen(Math.floor(last / 1000)))}` : "");
}

function renderOperators(didHash, primaryHealth, checkerHealth, divergence, chain) {
  const p = chain.status === "fulfilled" ? chain.value.pending : null;
  let verdict;
  if (divergence.status === "rejected") {
    verdict = failed("the checker's divergences", divergence.reason)
      + `<p class="netnote">You can read them directly at <a href="${CHECKER}/divergence/${esc(didHash)}" target="_blank" rel="noopener">${esc(CHECKER)}/divergence</a>.</p>`;
  } else {
    const list = (Array.isArray(divergence.value?.divergences) ? divergence.value.divergences : [])
      .filter(d => d && typeof d === "object").sort((a, b) => Number(b.at) - Number(a.at));
    const tolerance = Number(divergence.value?.tolerance);
    const rule = `It records one whenever its own score differs by more than ${Number.isFinite(tolerance) ? tolerance : "its tolerance in"} points.`;
    const mine = p ? list.filter(d => Number(d.proposedAt) === p.proposedAt) : [];
    const health = checkerHealth.status === "fulfilled" ? checkerHealth.value : null;
    const lastEpochMs = Number(health?.lastSuccessfulEpochMs) || 0;
    // A run writes its divergence seconds before it completes, so the run that wrote the newest
    // entry finishes just after it. A completion more than half an epoch later is a later run that
    // found nothing to record. With no health to go on, the newest entry stands.
    const laterRun = mine.length > 0 && lastEpochMs - Number(mine[0].at) > (Number(health?.epochMs) || 3600000) / 2;
    const when = (ms) => esc(fmtWhen(Math.floor(Number(ms) / 1000)));
    if (!p) {
      verdict = "<p>Nothing is pending, so there is nothing for the checker to check right now.</p>";
    } else if (mine.length) {
      const d = mine[0];
      const ev = d.evidence || {};
      const factors = Object.entries(d.factors || {}).map(([k, f]) => `${esc(k.replace(/Score$/, ""))} ${Number(f?.pending)} vs ${Number(f?.own)}`).join(", ");
      const gap = `the proposal says ${Number(d.pendingTotal)}, the checker got ${Number(d.ownTotal)} (${factors})`;
      verdict = laterRun
        ? `<p><span class="pill-ok">No disagreement now.</span> The checker disagreed with this proposal ${mine.length === 1 ? "once" : `${mine.length} times`}, last at ${when(d.at)}: ${gap}. Its latest run, at ${when(lastEpochMs)}, recorded nothing. ${rule}</p>`
        : `<p><span class="pill-err">Disagrees</span> with the pending proposal: ${gap}. Recorded at ${when(d.at)}.</p>`;
      if (isHash(ev.ownEvidenceRoot) && isHash(ev.proposedEvidenceRoot) && ev.ownEvidenceRoot.toLowerCase() !== ev.proposedEvidenceRoot.toLowerCase()) {
        verdict += `<p>That entry scored ${rootCode(ev.ownEvidenceRoot)} (${Number(ev.ownPaymentEvents)} payments) against a proposal made on ${rootCode(ev.proposedEvidenceRoot)}. Different evidence on each side can explain the gap, for example payments that settled after the proposal.</p>`;
      }
    } else if (lastEpochMs / 1000 > p.proposedAt) {
      verdict = `<p><span class="pill-ok">No disagreement</span> recorded for the pending proposal. The checker has run since it was made (last at ${when(lastEpochMs)}). ${rule}</p>`;
    } else {
      verdict = "<p>The checker has not run since the pending proposal was made, so it has no view on it yet.</p>";
    }
    const earlier = list.filter(d => !mine.includes(d));
    if (earlier.length) {
      verdict += `<p class="netnote">${earlier.length} earlier disagreement${earlier.length === 1 ? "" : "s"} for this agent: `
        + earlier.slice(0, 5).map(d => `${esc(fmtWhen(Math.floor(Number(d.at) / 1000)))} (${Number(d.pendingTotal)} proposed, ${Number(d.ownTotal)} by the checker)`).join("; ")
        + `. Outcomes are written up in <a href="${SOURCE}/blob/main/docs/divergence-log.md" target="_blank" rel="noopener">the divergence log</a>.</p>`;
    }
  }
  setCard("operatorsCard", `
    <dl class="kv">
      <dt>Primary</dt><dd class="prose">${healthLine(primaryHealth)}</dd>
      <dt>Checker</dt><dd class="prose">${healthLine(checkerHealth)}</dd>
    </dl>
    <h3>What the checker found</h3>
    ${verdict}`);
}

function epochItem(e, prevRoot, chain) {
  if (e.zeroed) {
    return `<li class="ep ep-cleared"><div class="ep-head"><b>Score zeroed by a slash</b><span>${esc(fmtWhen(e.at))}</span></div><div class="ep-meta">${txLink(e.tx)}</div></li>`;
  }
  const f = e.fate;
  let outcome, cls;
  if (!f) {
    const p = chain.status === "fulfilled" ? chain.value.pending : null;
    if (p && p.proposedAt === e.proposedAt) {
      const left = p.finalizableAt - Math.floor(Date.now() / 1000);
      outcome = `Pending, ${p.total} proposed. ` + (left > 0 ? `Finalizable from ${esc(fmtWhen(p.finalizableAt))}.` : "Finalizable now.");
    } else {
      outcome = "No longer pending on chain. The explorer has not indexed what ended it yet.";
    }
    cls = "ep-pending";
  } else if (f.kind === "finalized") {
    outcome = `Finalized at <b>${f.total}</b> on ${esc(fmtWhen(f.at))}, ${esc(fmtDuration(f.at - e.proposedAt))} after it was proposed. ${txLink(f.tx)}`;
    cls = "ep-final";
  } else if (f.kind === "replaced") {
    outcome = `Replaced by a newer proposal on ${esc(fmtWhen(f.at))}, before it was finalized.`;
    cls = "ep-replaced";
  } else if (f.kind === "rejected") {
    outcome = `Rejected by the committee (${addrLink(f.by)}) on ${esc(fmtWhen(f.at))}. ${txLink(f.tx)}`;
    cls = "ep-rejected";
  } else {
    outcome = `Cleared by a slash on ${esc(fmtWhen(f.at))}.`;
    cls = "ep-cleared";
  }
  const rootNote = e.root === null ? "no evidence root (before roots were added)"
    : `evidence ${rootCode(e.root)}` + (prevRoot !== undefined && prevRoot !== e.root ? ' <span class="pill-ok">evidence changed</span>' : "");
  return `<li class="ep ${cls}">
    <div class="ep-head"><b>Proposed ${esc(fmtWhen(e.proposedAt))}</b><span>${txLink(e.tx)}</span></div>
    <div class="ep-meta">${rootNote}</div>
    <div class="ep-outcome">${outcome}</div>
  </li>`;
}

function renderTimeline(history, chain, showAll) {
  if (history.status === "rejected") return setCard("timelineCard", failed("the explorer's history", history.reason));
  const { logs, truncated } = history.value;
  const epochs = buildEpochs(logs);
  if (!epochs.length) return setCard("timelineCard", "<p>No proposal has been made for this agent yet.</p>");
  const proposals = epochs.filter(e => !e.zeroed);
  const finalized = proposals.filter(e => e.fate?.kind === "finalized").length;
  // Each proposal's root is compared with the one before it, so the marker shows where the set
  // of committed payments changed.
  const items = [];
  let prevRoot;
  for (const e of epochs) {
    items.push(epochItem(e, prevRoot, chain));
    if (!e.zeroed) prevRoot = e.root;
  }
  items.reverse();
  const shown = showAll ? items : items.slice(0, TIMELINE_SHOWN);
  let html = `<p>${proposals.length} proposal${proposals.length === 1 ? "" : "s"} since ${esc(fmtWhen(proposals[0]?.proposedAt ?? epochs[0].at))}, ${finalized} finalized. Newest first.</p>`
    + `<ol class="timeline">${shown.join("")}</ol>`;
  if (shown.length < items.length) html += `<button class="btn btn-secondary btn-sm" id="showAllBtn" type="button">Show all ${items.length}</button>`;
  if (truncated) html += '<p class="netnote">The explorer returned more history than this page reads, so the oldest entries may be missing.</p>';
  setCard("timelineCard", html);
  const btn = $("showAllBtn");
  if (btn) btn.onclick = () => renderTimeline(history, chain, true);
}

// ---- recent activity across all agents ----
async function loadRecent() {
  const card = "recentCard";
  setCard(card, "<p class=\"netnote\">Reading the last day of proposals…</p>");
  try {
    const head = await blockNumber();
    const { logs } = await explorerLogs({}, Math.max(0, head - RECENT_BLOCKS));
    const byAgent = new Map();
    for (const l of logs) {
      if (!isHash(l.didHash)) continue;
      const a = byAgent.get(l.didHash) ?? { didHash: l.didHash, last: null, proposals: 0, score: null };
      a.last = l;
      if (l.name === "ScoreProposed") a.proposals++;
      if (l.name === "ReputationUpdated") a.score = l.total;
      byAgent.set(l.didHash, a);
    }
    const agents = [...byAgent.values()].sort((a, b) => b.last.block - a.last.block).slice(0, 20);
    if (!agents.length) return setCard(card, "<p>No agent was scored in the last day.</p>");
    const idents = await rpcBatch(agents.map(a => ({ to: IDENTITY, data: SEL.identities + pad32(a.didHash) })));
    const verb = { ScoreProposed: "proposed", ReputationUpdated: "finalized", ScoreRejected: "rejected", ReputationZeroed: "zeroed by a slash" };
    setCard(card, `<p>Agents with a proposal, finalization or rejection in about the last day, most recent first.</p>
      <ul class="recent">${agents.map((a, i) => {
        const addr = "0x" + strip(word(idents[i], 1)).slice(24);
        const who = isAddr(addr) && !/^0x0{40}$/.test(addr)
          ? `<a href="?a=${addr}"><code>${short(addr)}</code></a>` : `<code>${esc(short(a.didHash))}</code>`;
        return `<li>${who}<span>${esc(verb[a.last.name])} ${esc(fmtWhen(a.last.time))}</span>`
          + `<span>${a.score === null ? "" : `finalized at ${a.score}`}</span></li>`;
      }).join("")}</ul>`);
  } catch (e) {
    setCard(card, failed("recent activity", e));
  }
}

// ---- lookup ----
let lookupSeq = 0;
async function lookup(addr) {
  const seq = ++lookupSeq;
  const didHash = SigvaraDid.computeDidHash(addr, CHAIN_ID).toLowerCase();
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("a", addr);
    window.history.replaceState(null, "", u.toString());
  } catch (_) { /* a shareable URL is a nicety */ }
  $("recentCard").classList.add("u-hidden");
  for (const id of ["pendingCard", "evidenceCard", "operatorsCard", "timelineCard"]) setCard(id, '<p class="netnote">Reading…</p>');

  const [chain, history, evidence, primaryHealth, checkerHealth, divergence] = await Promise.allSettled([
    readChain(didHash),
    explorerLogs({ topic1: didHash }),
    getJson(`${PRIMARY}/evidence/${didHash}`),
    getJson(`${PRIMARY}/health`),
    getJson(`${CHECKER}/health`),
    getJson(`${CHECKER}/divergence/${didHash}`),
  ]);
  if (seq !== lookupSeq) return; // a newer lookup started while this one was reading
  renderAgent(addr, didHash, chain);
  renderPending(chain);
  renderEvidence(didHash, evidence, chain);
  renderOperators(didHash, primaryHealth, checkerHealth, divergence, chain);
  renderTimeline(history, chain, false);
}

// ---- init ----
(function init() {
  const input = $("agentAddr"), note = $("formNote");
  $("lookupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const a = input.value.trim();
    if (!isAddr(a)) { note.textContent = "That is not an address. It should be 0x followed by 40 hex characters."; return; }
    note.textContent = "";
    lookup(a);
  });
  const fromUrl = new URLSearchParams(window.location.search).get("a");
  if (fromUrl && isAddr(fromUrl)) {
    input.value = fromUrl;
    lookup(fromUrl);
  } else {
    loadRecent();
  }
})();
