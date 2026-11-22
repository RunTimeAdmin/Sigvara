"use strict";
// Slashes: every slash proceeding against an agent, rebuilt from the staking contract's events,
// with the evidence read from the transaction that filed it; and every slash of an oracle
// operator's bond. Sources are in explorer.js.

const X = window.SigvaraExplorer;
const $ = (id) => document.getElementById(id);
const STAKING_EVENTS = ["SlashInitiated", "SlashDisputed", "SlashExecuted", "SlashCancelled", "SlashVetoed"];

function setCard(id, html) {
  $(id).querySelector(".card-body").innerHTML = html;
  $(id).classList.remove("u-hidden");
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const words = (l) => (l.data.length > 2 ? Array.from({ length: (l.data.length - 2) / 64 }, (_, i) => BigInt(X.word(l.data, i))) : []);

// One explorer read at a time: two at once each take longer than either alone.
const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));

async function load() {
  setCard("slashCard", X.READING_HISTORY);
  setCard("bondSlashCard", X.READING_HISTORY);
  const [staking] = await Promise.all([settle(X.contractLogs(X.STAKING, STAKING_EVENTS)), X.loadSimulation()]);
  try { await renderSlashes(staking); } catch (e) { setCard("slashCard", X.failed("the slashes", e)); }
  const bond = await settle(X.contractLogs(X.ORACLE_BOND, X.BOND_EVENTS));
  try { renderBondSlashes(bond); } catch (e) { setCard("bondSlashCard", X.failed("the bond slashes", e)); }
}

// One entry per slash filed. A proceeding ends when it is executed or dropped; SlashCancelled is
// emitted for every drop (cancelled, vetoed, lapsed, or a dispute ruled for the agent), and a veto
// adds SlashVetoed after it.
function buildProceedings(logs) {
  const all = [], last = new Map();
  for (const l of logs) {
    const did = l.topics[1];
    if (!X.isHash(did)) continue;
    const w = words(l);
    if (l.name === "SlashInitiated") {
      const p = { didHash: did, reporter: X.topicAddr(l.topics[2]), victim: X.topicAddr(l.topics[3]), at: Number(w[0] ?? 0n) || l.time, tx: l.tx, disputed: null, end: null };
      all.push(p);
      last.set(did, p);
      continue;
    }
    const p = last.get(did);
    if (!p) continue;
    if (l.name === "SlashDisputed") p.disputed = { by: X.topicAddr(l.topics[2]), time: l.time, tx: l.tx };
    else if (l.name === "SlashExecuted") p.end = { kind: "executed", burned: w[0], toVictim: w[1], toReporter: l.legacy ? w[2] : 0n, legacy: l.legacy, time: l.time, tx: l.tx };
    else if (l.name === "SlashCancelled") p.end = { kind: "dropped", by: X.topicAddr(l.topics[2]), time: l.time, tx: l.tx };
    else if (l.name === "SlashVetoed" && p.end) p.end.vetoed = true;
  }
  return all;
}

// The evidence bytes the committee filed, from the initiateSlash call's own input.
function evidenceFrom(input) {
  if (typeof input !== "string" || !input.toLowerCase().startsWith(X.SEL.initiateSlash)) return null;
  const body = input.slice(10);
  const offset = Number(BigInt("0x" + body.slice(128, 192)));
  const len = Number(BigInt("0x" + body.slice(offset * 2, offset * 2 + 64)));
  const hex = body.slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
  if (hex.length !== len * 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = window.SigvaraDid.hexToBytes(hex);
  const text = bytes.every((b) => b >= 0x20 && b < 0x7f) ? String.fromCharCode(...bytes) : null;
  return { hex: "0x" + hex.toLowerCase(), text, len };
}

async function renderSlashes(staking) {
  if (staking.status === "rejected") return setCard("slashCard", X.failed("the staking contract's history from the explorer", staking.reason));
  const list = buildProceedings(staking.value.logs);
  // Each card says how its own history was read: the bond card's is a separate read, and its tail
  // can fail or fall short on its own.
  if (!list.length) return setCard("slashCard", "<p>No slash has been filed on this deployment.</p>" + X.historyNote(staking.value));

  const hashes = [...new Set(list.map((p) => p.didHash))];
  const [idents, txs] = await Promise.all([
    X.ethCalls(hashes.map((h) => ({ to: X.IDENTITY, data: X.SEL.identities + X.pad32(h) }))),
    X.rpcMany(list.map((p) => ["eth_getTransactionByHash", [p.tx]])).catch((e) => ({ failed: String(e?.message ?? e) })),
  ]);
  const addrOf = new Map(hashes.map((h, i) => [h, X.wordAddr(idents[i], 1)]));

  const executed = list.filter((p) => p.end?.kind === "executed").length;
  const dropped = list.filter((p) => p.end?.kind === "dropped").length;
  const open = list.length - executed - dropped;
  let html = `<p><b>${plural(list.length, "slash", "slashes")}</b> filed on this deployment: ${executed} executed, ${dropped} dropped, ${open} open.`
    + (list.some((p) => p.end?.legacy) ? " Slashes executed before 2 November 2026 paid the member who filed them a quarter of the stake; since then the committee is paid nothing (ADR 0007)." : "")
    + "</p>";
  if (X.simUnknown()) html += '<p class="pill-warn">The list of the testnet simulation\'s agents could not be read, so its agents are not marked as simulated below. Reload to try again.</p>';
  // What the room at the top of the page (slashes-scene.js) draws from, in the order filed.
  const drawn = [];
  html += [...list].reverse().map((p) => {
    const addr = addrOf.get(p.didHash);
    const agent = (X.isAddr(addr) && !/^0x0{40}$/.test(addr) ? `<a href="epochs?a=${addr}"><code>${X.short(addr)}</code></a>` : `<code>${X.esc(X.short(p.didHash))}</code>`)
      + (X.simAgent(addr) ? ` <span class="ex-note">simulated: ${X.esc(X.simAgent(addr))}</span>` : "");
    const tx = Array.isArray(txs) ? txs[list.indexOf(p)] : undefined;
    const ev = evidenceFrom(tx?.input);
    const evidence = ev
      ? (ev.text ? `“${X.esc(ev.text)}”` : `<code class="ex-evidence" title="${X.esc(ev.hex)}">${X.esc(ev.len === 32 ? X.short(ev.hex) : ev.hex)}</code>`)
        + (ev.len === 32 ? " (a 32-byte hash of an evidence package kept off chain)" : "")
      : txs?.failed ? `could not be read just now (${X.esc(txs.failed)}). Reload to try again`
      : tx == null ? "not read: the RPC did not return the transaction that filed it"
      : "not readable from the transaction that filed it";
    let outcome, cls;
    if (!p.end) {
      outcome = p.disputed ? `<span class="pill-warn">disputed</span> by the operator on ${X.esc(X.fmtWhen(p.disputed.time))}; the bond is frozen until the admin rules.` : '<span class="pill-warn">open</span>: inside or past its challenge window, not yet executed.';
      cls = "open";
    } else if (p.end.kind === "executed") {
      outcome = `<span class="pill-err">executed</span> on ${X.esc(X.fmtWhen(p.end.time))}: ${X.esc(X.fmtSvr(p.end.burned))} burned, ${X.esc(X.fmtSvr(p.end.toVictim))} to the victim`
        + (p.end.legacy ? `, ${X.esc(X.fmtSvr(p.end.toReporter))} to the member who filed it.` : ", nothing to the committee.") + ` ${X.txLink(p.end.tx)}`;
      cls = "done";
    } else {
      outcome = `<span class="pill-ok">${p.end.vetoed ? "vetoed" : "dropped"}</span> on ${X.esc(X.fmtWhen(p.end.time))} by ${X.whoIs(p.end.by)}. ${X.txLink(p.end.tx)}`;
      cls = "dropped";
    }
    const known = X.isAddr(addr) && !/^0x0{40}$/.test(addr);
    drawn.unshift({
      index: list.indexOf(p), agent: X.short(known ? addr : p.didHash), sim: X.simAgent(addr) || null, at: p.at,
      evidence: ev?.text ?? null, disputed: Boolean(p.disputed), state: !p.end ? "open" : p.end.kind, vetoed: Boolean(p.end?.vetoed), endTime: p.end?.time,
      burned: p.end?.burned ?? 0n, toVictim: p.end?.toVictim ?? 0n, toReporter: p.end?.toReporter ?? 0n,
      taken: (p.end?.burned ?? 0n) + (p.end?.toVictim ?? 0n) + (p.end?.toReporter ?? 0n),
    });
    return `<div class="ex-proceeding ${cls}" id="proceeding-${list.indexOf(p)}">
      <div class="ep-head"><b>Agent ${agent}</b><span>filed ${X.esc(X.fmtWhen(p.at))} ${X.txLink(p.tx)}</span></div>
      <dl class="kv">
        <dt>Filed by</dt><dd class="prose">${X.whoIs(p.reporter)}, a slashing committee member</dd>
        <dt>Victim</dt><dd class="prose">${X.whoIs(p.victim)}</dd>
        <dt>Evidence</dt><dd class="prose">${evidence}</dd>
        ${p.disputed ? `<dt>Disputed</dt><dd class="prose">by ${X.whoIs(p.disputed.by)} on ${X.esc(X.fmtWhen(p.disputed.time))}</dd>` : ""}
        <dt>Outcome</dt><dd class="prose">${outcome}</dd>
      </dl>
    </div>`;
  }).join("");
  if (staking.value.truncated) html += '<p class="pill-warn">The explorer has more history than this page reads, so the newest slashes may be missing.</p>';
  html += X.historyNote(staking.value);
  setCard("slashCard", html);
  // The scene is a module, so it may load before or after this.
  window.SigvaraSlashData = drawn;
  document.dispatchEvent(new Event("sigvara-slash-data"));
}

function renderBondSlashes(bond) {
  if (bond.status === "rejected") return setCard("bondSlashCard", X.failed("the bond contract's history from the explorer", bond.reason));
  const slashes = bond.value.logs.filter((l) => l.name === "OperatorSlashed").reverse();
  const notes = (bond.value.truncated ? '<p class="pill-warn">The explorer has more history than this page reads, so the newest slashes may be missing.</p>' : "")
    + X.historyNote(bond.value);
  if (!slashes.length) return setCard("bondSlashCard", "<p>No operator bond has been slashed.</p>" + notes);
  setCard("bondSlashCard", `<ul class="pay-list ex-history">${slashes.map((l) => {
    const w = words(l);
    return `<li><span>${X.esc(X.fmtWhen(l.time))}</span><span>${X.whoIs(X.topicAddr(l.topics[1]))}</span><span>${X.esc(X.fmtSvr(w[0]))} taken, ${X.esc(X.fmtSvr(w[1]))} left${w[2] ? ", demoted" : ""}. No evidence is recorded.</span><span>${X.txLink(l.tx)}</span></li>`;
  }).join("")}</ul>` + notes);
}

load();
