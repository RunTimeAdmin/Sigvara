"use strict";
// Operators: every address that has bonded in the oracle bond contract, its bond, status and
// signing key, how the two known oracle endpoints are running, and what the checker disagreed
// with. Sources are in explorer.js.

const X = window.SigvaraExplorer;
const $ = (id) => document.getElementById(id);
const DIVERGENCES_SHOWN = 15;
const HISTORY_SHOWN = 30;

function setCard(id, html) {
  $(id).querySelector(".card-body").innerHTML = html;
  $(id).classList.remove("u-hidden");
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const nameOf = (op) => X.OPERATORS[op.address] || (op.signer && X.OPERATORS[op.signer]) || null;

async function load() {
  setCard("operatorsCard", X.READING_HISTORY);
  const [history, primary, checker, divergence] = await Promise.allSettled([
    X.contractLogs(X.ORACLE_BOND, X.BOND_EVENTS),
    X.getJson(`${X.PRIMARY}/health`),
    X.getJson(`${X.CHECKER}/health`),
    X.getJson(`${X.CHECKER}/divergence`),
  ]);
  try { await renderOperators(history, { primary, checker }); } catch (e) { setCard("operatorsCard", X.failed("the operators", e)); }
  try { await renderDivergence(divergence); } catch (e) { setCard("divergenceCard", X.failed("the disagreements", e)); }
  try { renderHistory(history); } catch (e) { setCard("bondHistoryCard", X.failed("the bond history", e)); }
}

async function renderOperators(history, health) {
  if (history.status === "rejected") {
    return setCard("operatorsCard", X.failed("the bond contract's history from the explorer", history.reason) + healthList(health));
  }
  const addresses = [...new Set(history.value.logs.map((l) => X.topicAddr(l.topics[1])))].filter(X.isAddr);
  if (!addresses.length) return setCard("operatorsCard", "<p>No operator has bonded yet.</p>" + healthList(health));
  const reads = await X.ethCalls([
    { to: X.ORACLE_BOND, data: X.SEL.bondAmount },
    { to: X.ORACLE_BOND, data: X.SEL.slashBeneficiary },
    ...addresses.flatMap((a) => [
      { to: X.ORACLE_BOND, data: X.SEL.operators + X.pad32(a) },
      { to: X.ORACLE_BOND, data: X.SEL.signerOf + X.pad32(a) },
    ]),
  ]);
  const bondAmount = BigInt(reads[0]);
  const beneficiary = X.wordAddr(reads[1], 0);
  const ops = addresses.map((address, i) => {
    const op = reads[2 + i * 2], signer = X.wordAddr(reads[3 + i * 2], 0);
    return {
      address,
      bond: BigInt(X.word(op, 0)),
      status: Number(BigInt(X.word(op, 1))),
      unbondingAt: Number(BigInt(X.word(op, 2))),
      signer: /^0x0{40}$/.test(signer) ? null : signer,
    };
  });
  ops.sort((a, b) => b.status - a.status || (b.bond > a.bond ? 1 : b.bond < a.bond ? -1 : 0));
  const active = ops.filter((o) => o.status === 2).length;
  let html = `<p><b>${plural(active, "active operator")}</b> of ${plural(ops.length, "address", "addresses")} that ever bonded. An operator is active while its bond is at least <b>${X.esc(X.fmtSvr(bondAmount))}</b>.`
    + " Both operators named below are run by the Sigvara team, so they are two machines, not two independent parties. Independence is what a second operator is for, and it is not here yet.</p>";
  html += `<div class="ex-scroll"><table class="ex-table"><thead><tr><th>Operator</th><th>Status</th><th>Bond</th><th>Signs with</th></tr></thead><tbody>`;
  for (const o of ops) {
    const name = nameOf(o);
    html += `<tr>
      <td>${X.addrLink(o.address)}${name ? `<div class="ex-note">the ${X.esc(name)} oracle</div>` : ""}</td>
      <td>${X.esc(X.BOND_STATUS[o.status] ?? "?")}${o.status === 3 && o.unbondingAt ? `<div class="ex-note">since ${X.esc(X.fmtWhen(o.unbondingAt))}</div>` : ""}</td>
      <td class="num">${X.esc(X.fmtSvr(o.bond))}</td>
      <td>${o.signer ? X.addrLink(o.signer) : '<span class="ex-note">the operator address itself</span>'}</td>
    </tr>`;
  }
  html += "</tbody></table></div>";
  html += `<p class="netnote">A slashed operator bond goes to the slash beneficiary, ${X.addrLink(beneficiary)}, not to a burn. The bond contract's slash takes no evidence and has no appeal window; see <a href="slashes">Slashes</a>.</p>`;
  html += healthList(health);
  setCard("operatorsCard", html);
}

function healthList(health) {
  const line = (label, url, h) => {
    if (h.status === "rejected") return `<dt>${label}</dt><dd class="prose">${X.failed("its health", h.reason)}</dd>`;
    const v = h.value || {};
    const last = Number(v.lastSuccessfulEpochMs);
    return `<dt>${label}</dt><dd class="prose"><a href="${url}/health" target="_blank" rel="noopener">${X.esc(url.replace("https://", ""))}</a> runs ${X.commitLink(v.commit)}`
      + (Number(v.epochMs) ? `, one epoch every ${Math.round(Number(v.epochMs) / 60000)} min` : "")
      + (last ? `, last completed ${X.esc(X.fmtWhen(Math.floor(last / 1000)))}` : ", no epoch completed yet")
      + (v.paymentScan ? `; payment scanning ${X.esc(v.paymentScan)}` : "") + ".</dd>";
  };
  return `<h3>Running now</h3><dl class="kv">${line("Primary", X.PRIMARY, health.primary)}${line("Checker", X.CHECKER, health.checker)}</dl>`;
}

async function renderDivergence(divergence) {
  if (divergence.status === "rejected") {
    return setCard("divergenceCard", X.failed("the checker's disagreements", divergence.reason)
      + `<p class="netnote">You can read them directly at <a href="${X.CHECKER}/divergence" target="_blank" rel="noopener">${X.esc(X.CHECKER)}/divergence</a>.</p>`);
  }
  const v = divergence.value || {};
  const list = (Array.isArray(v.divergences) ? v.divergences : []).filter((d) => d && typeof d === "object" && X.isHash(d.didHash))
    .sort((a, b) => Number(b.at) - Number(a.at));
  const total = Number(v.total);
  let html = `<p>The checker records a disagreement when its own score differs from a pending proposal by more than ${Number.isFinite(Number(v.tolerance)) ? Number(v.tolerance) : "its tolerance in"} points. It has recorded <b>${Number.isFinite(total) ? total : list.length}</b>.`
    + " A disagreement is not proof of a wrong score, since the checker can be the one that is wrong: each one is triaged in public in "
    + `<a href="${X.SOURCE}/blob/main/docs/divergence-log.md" target="_blank" rel="noopener">the divergence log</a>.</p>`;
  if (v.seesProposals === false) {
    html += '<p class="pill-warn">The checker says its epoch is too long to see every proposal inside its challenge window, so an empty list here would not mean it agreed.</p>';
  }
  if (!list.length) {
    html += "<p>None recorded. The checker writes only disagreements, and a run that could not score an agent writes nothing either, so an empty list is not a confirmation.</p>";
    return setCard("divergenceCard", html);
  }
  // Each agent's address, so the entry can link to its epochs.
  const hashes = [...new Set(list.slice(0, DIVERGENCES_SHOWN).map((d) => d.didHash.toLowerCase()))];
  const idents = await X.ethCalls(hashes.map((h) => ({ to: X.IDENTITY, data: X.SEL.identities + X.pad32(h) })));
  const addrOf = new Map(hashes.map((h, i) => [h, X.wordAddr(idents[i], 1)]));
  html += `<ul class="pay-list ex-divergences">${list.slice(0, DIVERGENCES_SHOWN).map((d) => {
    const addr = addrOf.get(d.didHash.toLowerCase());
    const who = X.isAddr(addr) && !/^0x0{40}$/.test(addr) ? `<a href="epochs?a=${addr}"><code>${X.short(addr)}</code></a>` : `<code>${X.esc(X.short(d.didHash))}</code>`;
    return `<li><span>${X.esc(X.fmtWhen(Math.floor(Number(d.at) / 1000)))}</span><span>${who}</span><span>proposed ${Number(d.pendingTotal)}, checker got ${Number(d.ownTotal)}</span><span>proposal of ${X.esc(X.fmtWhen(Number(d.proposedAt)))}</span></li>`;
  }).join("")}</ul>`;
  if (v.truncated || list.length > DIVERGENCES_SHOWN) html += `<p class="netnote">Newest ${Math.min(list.length, DIVERGENCES_SHOWN)} shown.</p>`;
  setCard("divergenceCard", html);
}

function renderHistory(history) {
  if (history.status === "rejected") return setCard("bondHistoryCard", X.failed("the bond history", history.reason));
  const logs = [...history.value.logs].reverse();
  if (!logs.length) return setCard("bondHistoryCard", "<p>Nothing yet.</p>");
  const words = (l) => (l.data.length > 2 ? Array.from({ length: (l.data.length - 2) / 64 }, (_, i) => BigInt(X.word(l.data, i))) : []);
  const what = (l) => {
    const w = words(l);
    switch (l.name) {
      case "BondDeposited": return `deposited ${X.esc(X.fmtSvr(w[0]))}, bond now ${X.esc(X.fmtSvr(w[1]))}`;
      case "OperatorAdmitted": return "admitted by the admin";
      case "OperatorSlashed": return `<span class="pill-err">slashed ${X.esc(X.fmtSvr(w[0]))}</span>, ${X.esc(X.fmtSvr(w[1]))} left${w[2] ? ", demoted" : ""}`;
      case "UnbondInitiated": return `started unbonding, claimable ${X.esc(X.fmtWhen(Number(w[0])))}`;
      case "BondWithdrawn": return `withdrew ${X.esc(X.fmtSvr(w[0]))}`;
      case "OperatorRemoved": return "removed by the admin";
      case "SignerSet": return `signs with ${X.addrLink(X.topicAddr(l.topics[2]))}`;
      case "SignerCleared": return `stopped signing with ${X.addrLink(X.topicAddr(l.topics[2]))}`;
      default: return X.esc(l.name);
    }
  };
  const shown = logs.slice(0, HISTORY_SHOWN);
  setCard("bondHistoryCard", `<ul class="pay-list ex-history">${shown.map((l) =>
    `<li><span>${X.esc(X.fmtWhen(l.time))}</span><span>${X.addrLink(X.topicAddr(l.topics[1]))}</span><span>${what(l)}</span><span>${X.txLink(l.tx)}</span></li>`).join("")}</ul>`
    + (logs.length > shown.length ? `<p class="netnote">Newest ${shown.length} of ${logs.length} shown.</p>` : "")
    + (history.value.truncated ? '<p class="pill-warn">The explorer has more history than this page reads, so the newest entries may be missing.</p>' : ""));
}

load();
