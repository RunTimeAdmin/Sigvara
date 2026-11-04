"use strict";
// Integrate: one live answer from SigvaraReader, read by the visitor's browser, so the page shows
// the call it describes. Sources are in explorer.js.
(function () {
  const X = window.SigvaraExplorer;
  const Did = window.SigvaraDid;
  // From deployments/5042002.json; scripts/check-docs.mjs checks it.
  const READER = "0x2921b4eE879CdF5793FA273BbDc4E7dF01ABcef8";
  // Sigvara's demo agent, named in docs/slash-drill.md and docs/divergence-log.md.
  const AGENT = "0xCc52Cd92963f8A86d04dB29a4810d1e01D193910";
  const MIN_SCORE = 40;
  const MIN_BOND = 1000n * 10n ** 18n;

  const selector = (signature) => Did.keccak256(Did.utf8(signature)).slice(0, 10);
  const body = document.querySelector("#liveCard .card-body");
  const links = `<a class="btn btn-secondary btn-sm" href="check?a=${AGENT}">Check this agent</a> `
    + '<a class="btn btn-secondary btn-sm" href="agents">See every agent</a>';

  async function load() {
    try {
      const [trusted, trust] = await X.ethCalls([
        { to: READER, data: selector("isTrusted(address,uint8,uint256)") + X.pad32(AGENT) + X.pad32(MIN_SCORE.toString(16)) + X.pad32(MIN_BOND.toString(16)) },
        { to: READER, data: selector("trust(address)") + X.pad32(AGENT) },
      ]);
      const yes = BigInt(trusted) === 1n;
      // Nine words: registered, status, active, score, earned, stake, slash, collateralized, scoreUpdatedAt.
      const score = Number(BigInt(X.word(trust, 3)));
      const stake = BigInt(X.word(trust, 5));
      body.innerHTML = `<p><code>isTrusted(${X.short(AGENT)}, ${MIN_SCORE}, 1000e18)</code> just answered `
        + `<b class="${yes ? "pill-ok" : "pill-warn"}">${yes}</b>. Your browser asked the chain directly. This agent has a score of ${score} and a bond of ${X.esc(X.fmtSvr(stake))}.</p>`
        + `<p>${links}</p>`;
    } catch (e) {
      body.innerHTML = X.failed("the reader from the chain", e) + `<p>${links}</p>`;
    }
  }
  load();
})();
