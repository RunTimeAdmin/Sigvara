"use strict";
// Status: whether the testnet services are up, read from their public endpoints by the visitor's
// browser. The judgement is apart from the page so that oracle/status-page.test.js can hold it to
// the limits scripts/check-live.mjs applies on a schedule. Sources are in explorer.js.
(function (root) {
  const X = root.SigvaraExplorer || (typeof require === "function" ? require("./explorer.js") : null);

  const REFRESH_MS = 60 * 1000;
  const READ_TIMEOUT_MS = 20 * 1000;
  // How many epoch lengths without a finished epoch is late, and then down. Three, at one epoch an
  // hour, is scripts/check-live.mjs's limit for a missed run.
  const EPOCHS_LATE = 2;
  const EPOCHS_DOWN = 3;
  // About five minutes of Arc blocks. The index's own /health fails at 3,600, about half an hour.
  const INDEX_LATE_BLOCKS = 600;
  const SECONDS_PER_BLOCK = 0.5;

  // In order of how much a visitor should hear about it.
  const STATES = {
    ok: { rank: 0, label: "running", pill: "pill-ok" },
    attention: { rank: 1, label: "look at this", pill: "pill-warn" },
    unreachable: { rank: 2, label: "no answer", pill: "pill-err" },
    down: { rank: 3, label: "down", pill: "pill-err" },
  };

  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 2) return "a moment";
    if (s < 90) return `${s} seconds`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
  }
  const bodyOf = (read) => (read.value?.body && typeof read.value.body === "object" ? read.value.body : {});
  const noAnswer = (read) => ({
    state: "unreachable",
    text: `Your browser could not read it: ${X.esc(read.reason?.name === "AbortError" ? "timed out" : read.reason?.message ?? read.reason)}.`,
  });

  // An operator's /health. It answers 503 when it is unhealthy, with the reason in the body.
  function assessOracle(read) {
    if (read.status === "rejected") return noAnswer(read);
    const v = bodyOf(read);
    const last = Number(v.lastSuccessfulEpochMs), since = Number(v.timeSinceLastEpochMs);
    const epochMs = Number(v.epochMs) > 0 ? Number(v.epochMs) : 3600 * 1000;
    const ran = last > 0 && Number.isFinite(since);
    const every = `one every ${Math.round(epochMs / 60000)} minutes`;
    const notSaving = v.storeWritable === false || v.statePersisted === false;
    let state = "ok";
    if (read.value.httpStatus !== 200 || v.ok !== true || notSaving || (ran && since > EPOCHS_DOWN * epochMs)) state = "down";
    else if (ran && since > EPOCHS_LATE * epochMs) state = "attention";
    const said = [];
    if (state === "down") said.push(`It reports a problem (HTTP ${Number(read.value.httpStatus)}).`);
    if (notSaving) said.push("Its state is not being saved.");
    said.push(ran
      ? `Last epoch finished ${ago(since)} ago, at ${X.esc(X.fmtWhen(Math.floor(last / 1000)))}, ${every}.`
      : `No epoch has finished since it started ${ago(Number(v.uptimeSeconds) * 1000 || 0)} ago, ${every}.`);
    if (v.epochRunning === true) said.push("One is running now.");
    if (v.commit) said.push(`Runs ${X.commitLink(v.commit)}.`);
    return { state, text: said.join(" ") };
  }

  // The event index's /health, against the chain's newest block as this browser read it, so the lag
  // does not rest on the index's own word. It also answers 503 when unhealthy.
  function assessIndex(read, head) {
    if (read.status === "rejected") return noAnswer(read);
    const v = bodyOf(read);
    const toBlock = Number(v.toBlock);
    const lag = head.status === "fulfilled" && toBlock > 0 ? Math.max(0, head.value - toBlock)
      : v.behind != null && Number.isFinite(Number(v.behind)) ? Number(v.behind) : null;
    let state = "ok";
    if (read.value.httpStatus !== 200 || v.ok !== true) state = "down";
    else if (lag === null || lag > INDEX_LATE_BLOCKS) state = "attention";
    const said = [];
    if (state === "down") said.push(`It reports a problem (HTTP ${Number(read.value.httpStatus)}).`);
    said.push(lag === null ? "It does not say how far behind the chain it is."
      : `${plural(lag, "block")} behind the chain, about ${ago(lag * SECONDS_PER_BLOCK * 1000)}.`);
    if (state === "down" && v.lastError) said.push(`Last error: ${X.esc(v.lastError)}.`);
    return { state, text: said.join(" ") };
  }

  // The checker's /divergence. As in scripts/check-live.mjs, a record matters while its proposal can
  // still be rejected, and one without a readable proposal time or window counts as open.
  function assessDivergence(read, nowMs = Date.now()) {
    if (read.status === "rejected") return noAnswer(read);
    if (read.value.httpStatus !== 200) {
      return { state: "down", text: `It reports a problem (HTTP ${Number(read.value.httpStatus)}).` };
    }
    const v = bodyOf(read);
    const list = (Array.isArray(v.divergences) ? v.divergences : []).filter((d) => d && typeof d === "object");
    const total = Number.isSafeInteger(Number(v.total)) ? Number(v.total) : list.length;
    const windowSec = Number(v.challengeWindowHours) * 3600;
    const open = list.filter((d) => {
      const proposedAt = Number(d.proposedAt);
      return !(proposedAt > 0) || !(windowSec > 0) || proposedAt + windowSec > nowMs / 1000;
    }).length;
    const blind = v.mode !== "checker" || v.seesProposals === false;
    const said = [];
    if (v.mode !== "checker") said.push(`The endpoint reports mode "${X.esc(v.mode)}" where a checker is expected.`);
    else if (v.seesProposals === false) said.push("The checker's epoch is too long to see every proposal in time, so few here would not mean it agreed.");
    if (total === 0) {
      said.push("None on record. The checker writes only disagreements, so that is not a confirmation.");
    } else {
      const newest = Math.max(...list.map((d) => Number(d.at)).filter((at) => at > 0), 0);
      said.push(`${v.truncated ? "At least " : ""}${plural(total, "disagreement")} on record`
        + (newest ? `, the newest at ${X.esc(X.fmtWhen(Math.floor(newest / 1000)))}` : "")
        + (open ? `; ${open} can still be rejected.` : "; none can still be rejected."));
    }
    const text = said.join(" ");
    return blind || open ? { state: "attention", text } : { state: "ok", label: "none open", text };
  }

  function assessChain(head) {
    if (head.status === "rejected") return noAnswer(head);
    return { state: "ok", label: "answering", text: `Newest block ${Number(head.value).toLocaleString("en-US")}. The RPC is Arc's, not Sigvara's.` };
  }

  // The worst state among the rows, for the line at the top.
  const overall = (rows) => rows.reduce((worst, r) => (STATES[r.state].rank > STATES[worst].rank ? r.state : worst), "ok");

  const HEADLINES = {
    ok: "All running.",
    attention: "Running, with something to look at.",
    unreachable: "Not everything answered.",
    down: "Something is down.",
  };

  // Like getJson, but the body of an error status is kept: it says why.
  async function readEndpoint(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      return { httpStatus: res.status, body: await res.json().catch(() => null) };
    } finally {
      clearTimeout(timer);
    }
  }

  function render(rows) {
    const worst = overall(rows);
    const link = (r) => (r.href ? `<a href="${r.href}"${r.href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${r.name}</a>` : r.name);
    document.querySelector("#statusCard .card-body").innerHTML =
      `<p><b class="${STATES[worst].pill}">${HEADLINES[worst]}</b> `
      + `<span class="netnote">Checked ${X.esc(X.fmtWhen(Math.floor(Date.now() / 1000)))}. Reads again every minute while this tab is open.</span></p>`
      + (rows.some((r) => r.state === "unreachable")
        ? '<p class="netnote">No answer can be your connection rather than the service, so try the link from elsewhere before calling it an outage.</p>' : "")
      + `<dl class="kv">${rows.map((r) => `<dt>${link(r)}</dt><dd class="prose"><span class="${STATES[r.state].pill}">${r.label ?? STATES[r.state].label}</span> ${r.text}</dd>`).join("")}</dl>`;
  }

  let reading = false;
  async function refresh() {
    if (reading) return;
    reading = true;
    try {
      const [primary, checker, divergence, index, head] = await Promise.allSettled([
        readEndpoint(`${X.PRIMARY}/health`),
        readEndpoint(`${X.CHECKER}/health`),
        readEndpoint(`${X.CHECKER}/divergence`),
        readEndpoint(`${X.INDEX}/health`),
        X.blockNumber(),
      ]);
      render([
        { name: "Primary oracle", href: `${X.PRIMARY}/health`, ...assessOracle(primary) },
        { name: "Checker", href: `${X.CHECKER}/health`, ...assessOracle(checker) },
        { name: "Disagreements", href: "operators", ...assessDivergence(divergence) },
        { name: "Event index", href: `${X.INDEX}/health`, ...assessIndex(index, head) },
        { name: "Arc testnet RPC", ...assessChain(head) },
      ]);
    } catch (e) {
      document.querySelector("#statusCard .card-body").innerHTML = X.failed("the services", e);
    } finally {
      reading = false;
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { assessOracle, assessIndex, assessDivergence, assessChain, overall };
  }
  if (typeof document !== "undefined") {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
})(typeof window !== "undefined" ? window : globalThis);
