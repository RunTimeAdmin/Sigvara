/* Live status for the testnet on-ramp.
 *
 * Read-only: every number here comes from an eth_call against the public Arc RPC, so
 * the page works with no wallet, no extension and no oracle. Paste an address and each
 * step reports whether that address has actually cleared it.
 *
 * The oracle is deliberately not a dependency. It runs on one host behind a firewall,
 * and a page that goes blank when that host restarts is a bad first impression for
 * someone deciding whether the protocol is real.
 */
(function () {
  "use strict";

  var RPC = "https://rpc.testnet.arc.io";
  var CHAIN_ID = 5042002;
  var EXPLORER = "https://explorer.testnet.arc.io";

  var IDENTITY   = "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd";
  var REPUTATION = "0x6603C96275e85F724Cdf74666b399365e4cA29ed";
  var STAKING    = "0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B";
  var SVR        = "0x41De2D6D55318e197a00E8f5B496eA2790e23E6c";

  // 4-byte selectors, precomputed with `cast sig` and re-checked against src/*.sol by
  // scripts/check-docs.mjs. A contract change that alters one of these fails the build
  // rather than quietly turning every field on this page into a zero.
  var SEL = {
    identities: "0x81638e9b", getTotalScore: "0x2522be94", getPendingScore: "0x56cf76e7",
    getStake: "0xe765c122", minimumStake: "0xec5ffac2",
    balanceOf: "0x70a08231", lastFaucetUse: "0xeee96fef",
  };

  var FAUCET_COOLDOWN = 86400;     // SVRToken.FAUCET_COOLDOWN, in seconds

  var $ = function (id) { return document.getElementById(id); };
  var strip = function (h) { return String(h).indexOf("0x") === 0 ? String(h).slice(2) : String(h); };
  var pad32 = function (h) { return strip(h).toLowerCase().padStart(64, "0"); };
  var word  = function (d, i) { return "0x" + strip(d).slice(i * 64, (i + 1) * 64); };

  /**
   * One HTTP request for every read on the page.
   *
   * Arc answers a JSON-RPC batch array. Eight reads issued one at a time is eight round
   * trips; batched it is one, which is the difference between the page feeling live and
   * feeling broken. Results are matched on id because a node may answer out of order,
   * and an off-by-one here would show every value against the wrong label.
   */
  async function rpcBatch(calls) {
    var body = calls.map(function (c, i) {
      return {
        jsonrpc: "2.0", id: i,
        method: c.method || "eth_call",
        params: c.params || [{ to: c.to, data: c.data }, "latest"],
      };
    });
    var res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var arr = await res.json();
    if (!Array.isArray(arr)) throw new Error((arr && arr.error && arr.error.message) || "RPC batch failed");
    var byId = {};
    arr.forEach(function (r) { byId[r.id] = r; });
    return calls.map(function (_, i) {
      var r = byId[i];
      if (!r || r.error) throw new Error((r && r.error && r.error.message) || "missing result");
      return r.result;
    });
  }

  // Whole-token display for an 18-decimal balance. Two decimals is enough to tell
  // "funded" from "empty", which is all this page asks of the number.
  function tokens(raw) {
    var v = BigInt(raw || "0x0");
    var whole = v / 1000000000000000000n;
    var frac = (v % 1000000000000000000n) / 10000000000000000n;
    return whole.toLocaleString("en-US") + "." + String(frac).padStart(2, "0");
  }

  // `label` overrides the default wording for states where "your turn" would be a lie,
  // such as a proposed score sitting out its challenge window with nothing for the
  // reader to do.
  function setStep(n, state, note, label) {
    var el = document.querySelector('.step[data-step="' + n + '"]');
    if (!el) return;
    el.setAttribute("data-state", state);
    el.querySelector(".step-state").textContent =
      label || { done: "Done", active: "Your turn", locked: "Waiting" }[state] || state;
    var out = el.querySelector(".step-live");
    if (out) out.innerHTML = note || "";
  }

  function ok(t)   { return '<span class="ok">' + t + "</span>"; }
  function warn(t) { return '<span class="warn">' + t + "</span>"; }

  function reset(msg) {
    [1, 2, 3, 4, 5].forEach(function (n) { setStep(n, n === 1 ? "active" : "locked", ""); });
    $("cardDid").textContent = msg || "paste an address to check";
    $("cardOperator").textContent = "—";
    $("cardScore").textContent = "—";
    $("cardStatus").textContent = "None";
    $("cardStatus").setAttribute("data-s", "None");
    $("cardStake").textContent = "—";
    $("cardGas").textContent = "—";
    $("cardSvr").textContent = "—";
  }

  async function check(addr) {
    var did = window.SigvaraDid.computeDidHash(addr, CHAIN_ID);

    var out = await rpcBatch([
      { method: "eth_getBalance", params: [addr, "latest"] },
      { to: SVR,        data: SEL.balanceOf       + pad32(addr) },
      { to: SVR,        data: SEL.lastFaucetUse   + pad32(addr) },
      { to: IDENTITY,   data: SEL.identities      + pad32(did) },
      { to: STAKING,    data: SEL.getStake        + pad32(did) },
      { to: STAKING,    data: SEL.minimumStake },
      { to: REPUTATION, data: SEL.getTotalScore   + pad32(did) },
      { to: REPUTATION, data: SEL.getPendingScore + pad32(did) },
    ]);

    var gasRaw = out[0];
    var svrRaw = out[1];
    var lastFaucet = Number(BigInt(out[2]));
    var ident = out[3];
    var stake = BigInt(out[4]);
    var minStake = BigInt(out[5]);
    var score = Number(BigInt(out[6]));
    var pending = out[7];

    // Index matches SigvaraIdentity.AgentStatus.
    var registeredAt = BigInt(word(ident, 4));
    var statusNum = Number(BigInt(word(ident, 3)));
    var statusStr = ["Active", "Suspended", "Slashed", "PendingBond"][statusNum] || "?";
    var registered = registeredAt !== 0n;

    /* Gas and tokens are the operator's problem, not the agent's.
     *
     * The DID comes from the agent address, but the wallet that pays for registration
     * and holds the bond is the operator, and the two are usually different. Reading
     * balances off the agent address made an agent that is registered, bonded and
     * scored render as "step 1 not started", which reads as a broken page rather than
     * a correct one. Once an identity exists, the contract knows who the operator is,
     * so ask it and report on the wallet that actually pays. */
    var operator = "0x" + strip(word(ident, 0)).slice(24);
    var funder = addr;
    if (registered && !/^0x0+$/.test(operator) && operator.toLowerCase() !== addr.toLowerCase()) {
      funder = operator;
      var more = await rpcBatch([
        { method: "eth_getBalance", params: [funder, "latest"] },
        { to: SVR, data: SEL.balanceOf     + pad32(funder) },
        { to: SVR, data: SEL.lastFaucetUse + pad32(funder) },
      ]);
      gasRaw = more[0];
      svrRaw = more[1];
      lastFaucet = Number(BigInt(more[2]));
    }
    var gas = BigInt(gasRaw);
    var svrBal = BigInt(svrRaw);
    var whose = funder.toLowerCase() === addr.toLowerCase() ? "this address" : "the operator";

    $("cardDid").textContent = did.slice(0, 18) + "…" + did.slice(-6);
    $("cardOperator").textContent = registered ? operator.slice(0, 10) + "…" + operator.slice(-6) : "—";
    $("cardGas").textContent = tokens(gasRaw) + " USDC";
    $("cardSvr").textContent = tokens(svrRaw) + " SVR";
    $("cardStake").textContent = tokens(out[4]) + " / " + tokens(out[5]) + " SVR";
    $("cardScore").textContent = registered ? score + " / 100" : "—";
    $("cardStatus").textContent = registered ? statusStr : "None";
    $("cardStatus").setAttribute("data-s", registered && statusNum < 3 ? statusStr : "None");

    // 1 - gas. Everything downstream is a transaction, so this gates the rest.
    if (gas > 0n) setStep(1, "done", ok(tokens(gasRaw) + " USDC") + " on " + whose);
    else if (registered) setStep(1, "done", "already spent - " + whose + " now holds " + tokens(gasRaw) + " USDC");
    else setStep(1, "active", warn("0 USDC") + " - nothing can be sent yet");

    // 2 - bond tokens.
    var nowSec = Math.floor(Date.now() / 1000);
    var faucetReady = lastFaucet === 0 || nowSec >= lastFaucet + FAUCET_COOLDOWN;
    if (minStake > 0n && stake >= minStake) {
      setStep(2, "done", "already bonded - " + whose + " holds " + tokens(svrRaw) + " SVR spare");
    } else if (minStake > 0n && svrBal >= minStake) {
      setStep(2, "done", ok(tokens(svrRaw) + " SVR") + " on " + whose + " - enough to bond");
    } else if (gas === 0n && !registered) {
      setStep(2, "locked", "needs gas first");
    } else if (faucetReady) {
      setStep(2, "active", tokens(svrRaw) + " SVR on " + whose + ". Faucet is " + ok("ready") + ".");
    } else {
      var when = new Date((lastFaucet + FAUCET_COOLDOWN) * 1000).toISOString().replace("T", " ").slice(0, 16);
      setStep(2, "active", tokens(svrRaw) + " SVR on " + whose + ". Faucet again after " + warn(when + " UTC") + ".");
    }

    // 3 - registration.
    if (registered) {
      var when3 = new Date(Number(registeredAt) * 1000).toISOString().slice(0, 10);
      setStep(3, "done", ok("registered") + " on " + when3 + ", status " + statusStr);
    } else if (gas === 0n) {
      setStep(3, "locked", "needs gas first");
    } else {
      setStep(3, "active", "no identity at this address yet");
    }

    // 4 - bond. PendingBond is the state that catches people out: registered, visible
    // on chain, and not yet an agent anyone should rely on.
    if (!registered) {
      setStep(4, "locked", "register first");
    } else if (minStake > 0n && stake >= minStake) {
      setStep(4, "done", ok(tokens(out[4]) + " SVR bonded") + ", minimum is " + tokens(out[5]));
    } else {
      setStep(4, "active", warn(tokens(out[4]) + " SVR bonded") + ", minimum is " + tokens(out[5]));
    }

    // 5 - score.
    var hasPending = false;
    try { hasPending = BigInt(word(pending, 8)) === 1n; } catch (e) { hasPending = false; }
    if (!registered) {
      setStep(5, "locked", "register first");
    } else if (hasPending) {
      var proposedAt = Number(BigInt(word(pending, 7)));
      setStep(5, "active", warn("a score is proposed") + " and inside its challenge window, proposed "
        + new Date(proposedAt * 1000).toISOString().replace("T", " ").slice(0, 16)
        + " UTC. Anyone may finalize it once the window closes.", "In window");
    } else if (score > 0) {
      setStep(5, "done", ok(score + " / 100") + " finalized on chain");
    } else {
      setStep(5, "active", "no score yet - the first epoch sets the community baseline");
    }
  }

  function run() {
    var addr = $("addr").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { reset("that is not a 20-byte address"); return; }
    $("cardDid").textContent = "reading chain…";
    check(addr).catch(function (e) {
      reset("");
      $("cardDid").textContent = "read failed: " + e.message;
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("explorerLink").href = EXPLORER;
    $("checkBtn").addEventListener("click", run);
    $("addr").addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });

    // An address in the query string makes the page linkable: paste ?a=0x... into a
    // message and the recipient lands on their own status rather than a blank form.
    var q = new URLSearchParams(location.search).get("a");
    if (q) { $("addr").value = q; run(); }
  });
})();
