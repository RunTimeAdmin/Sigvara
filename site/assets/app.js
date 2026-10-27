"use strict";
// No external libraries on purpose: a CDN script on a wallet page is a supply-chain risk.
// Reads go straight to the public RPC; writes go through the user's wallet.

const CHAIN_ID = 5042002, CHAIN_HEX = "0x4cef52";
const RPC = "https://rpc.testnet.arc.io";
const EXPLORER = "https://explorer.testnet.arc.io";
// From deployments/5042002.json — the Arc testnet deploy.
const IDENTITY   = "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd";
const REPUTATION = "0x6603C96275e85F724Cdf74666b399365e4cA29ed";
const SVR        = "0x41De2D6D55318e197a00E8f5B496eA2790e23E6c";
const STAKING    = "0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B";
// SigvaraEpochFees is not part of this deploy, so there is no registry to read.
// Pointing at 0x0 is worse than useless: eth_call returns empty and BigInt throws,
// which would abort the whole lookup. Everything fee-related is switched off.
const FEES       = "0x0000000000000000000000000000000000000000";
const FEES_LIVE  = !/^0x0{40}$/i.test(FEES);

// 4-byte selectors, precomputed with `cast sig`
const SEL = {
  computeDidHash: "0xc5d4962d", identities: "0x81638e9b", getTotalScore: "0x2522be94",
  epochFee: "0x41e4cfa8", balance: "0x89eba421", isCovered: "0xcb607e4f",
  depositFor: "0x1da1bbfb", withdraw: "0x040cf020",
  approve: "0x095ea7b3", allowance: "0xdd62ed3e", balanceOf: "0x70a08231", faucet: "0x57915897",
  svr: "0x39e1a28a", symbol: "0x95d89b41", decimals: "0x313ce567", registerAgent: "0x367260d7", registrationDigest: "0x9aad085f",
  getReputation: "0xd14519d2", getPendingScore: "0x56cf76e7", challengeWindow: "0x861a1412",
  // SigvaraStaking. Verified with `cast sig`, not guessed: getStake and minimumStake
  // match the pair testnet.js already uses against the same deployment.
  depositStake: "0xbeb78671", initiateWithdrawal: "0xa3d6f72b", claimWithdrawal: "0x8e88eccc",
  getStake: "0xe765c122", minimumStake: "0xec5ffac2", getPendingWithdrawal: "0xd0fe00db",
  unbondingPeriod: "0x6cf6d675", getSlashProposal: "0xc984f6f8",
  // Slash handling, status and the pause. Verified against src/ by scripts/check-docs.mjs.
  // All but inflowsPausedUntil exist on the September contracts as well; inflowsPausedUntil
  // exists only on main, so every read of it is optional.
  disputeSlash: "0xa7af7008", claimSlashProceeds: "0xe61a2b5d", claimable: "0x402914f5",
  DISPUTE_RESOLUTION_PERIOD: "0xf0d1dc00", slashSuspended: "0x72657d89", updateStatus: "0x054372ed",
  inflowsPausedUntil: "0xeed6e97a",
};
// factor label, on-chain word index, and max — mirrors SigvaraReputation.ReputationData
const FACTORS = [
  ["fee", 0, 20], ["success", 1, 15], ["age", 2, 30],
  ["external", 3, 25], ["community", 4, 5], ["propagation", 5, 5],
];

// ABI-encodes a trailing dynamic `bytes` argument. `headWords` is the number of
// 32-byte head slots the call has in total, including this argument's offset slot,
// because the offset is measured from the start of the head. Passing the wrong count
// produces a call that encodes cleanly and decodes to garbage.
function encBytes(hex, headWords) {
  const body = strip(hex);
  const len = body.length / 2;
  const padded = body + "0".repeat((32 - (len % 32)) % 32 * 2);
  return encUint(BigInt(headWords * 32)) + encUint(BigInt(len)) + padded;
}

const $ = (id) => document.getElementById(id);
let account = null, currentDidHash = null, currentAgent = null;
// fee token metadata, read from the chain at load (SVR on testnet, USDC/WETH on mainnet)
let tokenAddr = SVR, tokenSymbol = "tokens", tokenDecimals = 18n;

// ---- wallet discovery (EIP-6963) ----
// Multiple extensions fight over window.ethereum (Phantom grabs it aggressively
// and can't add custom chains). Discover every injected wallet and let the user
// pick instead of trusting whoever won the injection race.
let wallet = null;
const discovered = new Map(); // uuid -> {info, provider}
window.addEventListener("eip6963:announceProvider", (e) => discovered.set(e.detail.info.uuid, e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

function candidateWallets() {
  let list;
  if (discovered.size) {
    list = [...discovered.values()].map(d => ({ name: d.info.name, provider: d.provider, rdns: d.info.rdns || "" }));
  } else {
    const eth = window.ethereum;
    if (!eth) return [];
    const provs = eth.providers?.length ? eth.providers : [eth];
    list = provs.map(p => ({
      name: p.isMetaMask ? "MetaMask" : p.isPhantom ? "Phantom" : p.isRabby ? "Rabby" : "Injected wallet",
      provider: p, rdns: "",
    }));
  }
  // MetaMask first: it handles custom chains; Phantom does not
  return list.sort((a, b) => (b.rdns === "io.metamask" || b.name === "MetaMask") - (a.rdns === "io.metamask" || a.name === "MetaMask"));
}

// Escape anything that did not come from our own template strings before it hits innerHTML.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function logLine(html) {
  const el = $("log");
  // insertAdjacentHTML appends. `innerHTML +=` read the whole log back out, reparsed it
  // together with the new line, and rebuilt the subtree, so the nth message cost work
  // proportional to everything already logged. Reading .innerHTML for the emptiness test
  // was a second serialization of the same thing; childNodes.length answers it directly.
  el.insertAdjacentHTML("beforeend", (el.childNodes.length ? "\n" : "") + html);
  el.scrollTop = el.scrollHeight;
}
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${h.slice(0, 18)}…</a>`;

// ---- encoding helpers ----
const strip = (h) => h.startsWith("0x") ? h.slice(2) : h;
const pad32 = (h) => strip(h).toLowerCase().padStart(64, "0");
const encAddr = (a) => pad32(a);
const encUint = (n) => pad32(n.toString(16));
const word = (data, i) => "0x" + strip(data).slice(i * 64, (i + 1) * 64);

function parseUnits(s) {
  s = s.trim();
  const d = Number(tokenDecimals);
  if (!new RegExp(`^\\d+(\\.\\d{1,${d}})?$`).test(s)) throw new Error("bad amount");
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10n ** tokenDecimals + BigInt(f.padEnd(d, "0"));
}
function formatUnits(v) {
  const d = Number(tokenDecimals);
  const i = v / 10n ** tokenDecimals, f = (v % 10n ** tokenDecimals).toString().padStart(d, "0").slice(0, 4).replace(/0+$/, "");
  return f ? `${i}.${f}` : i.toString();
}
function decodeString(hex) {
  const data = strip(hex);
  const len = Number(BigInt("0x" + data.slice(64, 128)));
  const bytes = data.slice(128, 128 + len * 2);
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

// ---- chain io ----
async function rpcRead(to, data) {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] };
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Many reads, one request.
//
// A lookup used to be six sequential round trips because each read awaited the last,
// even though nothing after the first depended on anything but the didHash. At ~124 ms
// a trip that is most of a second of staring at a spinner. JSON-RPC allows a batch array
// and Arc's node answers one, so the whole lookup costs a single round trip.
//
// Responses may come back in any order, so results are matched on id rather than
// position, and one failed call reports itself rather than silently shifting the rest.
async function rpcBatch(calls) {
  if (calls.length === 0) return [];
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error(arr?.error?.message ?? "batch call failed");
  const byId = new Map(arr.map(r => [r.id, r]));
  return calls.map((c, i) => {
    const r = byId.get(i);
    if (!r || r.error) {
      const msg = r?.error?.message ?? "missing result in batch";
      // An optional read is for something only newer contracts have. Its absence is an
      // answer (null); a rate limit is not, and must not pass for "the contract lacks it".
      if (c.optional && r && !/rate limit/i.test(msg)) return null;
      throw new Error(msg);
    }
    return r.result;
  });
}

// challengeWindow is a per-deployment constant, so it is fetched once rather than on
// every lookup.
let challengeWindowCache = null;
async function getChallengeWindow() {
  if (challengeWindowCache === null) {
    challengeWindowCache = Number(BigInt(await rpcRead(REPUTATION, SEL.challengeWindow)));
  }
  return challengeWindowCache;
}
async function sendTx(to, data) {
  const hash = await wallet.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to, data }],
  });
  logLine(`tx sent ${txLink(hash)} — waiting…`);
  // Arc produces a block roughly every half second. A flat 2.5s poll added over a second
  // of dead time to every confirmation for nothing, so start at the block interval and
  // widen only if the transaction is genuinely slow. Same 60-attempt ceiling, which now
  // spans longer in wall clock than it used to rather than less.
  let wait = 500;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, wait));
    if (wait < 2500) wait = Math.min(2500, wait * 1.5);
    const rec = await wallet.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (rec) {
      if (rec.status === "0x1") { logLine(`<span class="pill-ok">confirmed</span> in block ${parseInt(rec.blockNumber, 16)}`); return; }
      throw new Error("transaction reverted");
    }
  }
  throw new Error("timed out waiting for receipt");
}

// ---- wallet ----
async function connect() {
  const cands = candidateWallets();
  if (!cands.length) { logLine('<span class="pill-err">No wallet found — install MetaMask.</span>'); return; }
  if (cands.length === 1) return connectWith(cands[0]);
  const el = $("walletStatus");
  el.textContent = "choose wallet: ";
  for (const c of cands) {
    const b = document.createElement("button");
    b.className = "btn btn-secondary";
    b.style.cssText = "padding:5px 12px;font-size:13px;margin-left:8px";
    b.textContent = c.name;
    b.onclick = () => connectWith(c);
    el.appendChild(b);
  }
}

async function connectWith(c) {
  try {
    wallet = c.provider;
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    account = accounts[0];
    const chain = await wallet.request({ method: "eth_chainId" });
    if (chain !== CHAIN_HEX) {
      try {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
      } catch (e) {
        await wallet.request({ method: "wallet_addEthereumChain", params: [{
          chainId: CHAIN_HEX, chainName: "Arc Testnet",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC], blockExplorerUrls: [EXPLORER],
        }]});
      }
    }
    $("walletStatus").innerHTML = `<span class="pill-ok">${esc(c.name)}: ${account.slice(0, 6)}…${account.slice(-4)} on 5042002</span>`;
    // Deposits and withdrawals need a fee registry; the faucet does not.
    (FEES_LIVE ? ["depositBtn", "withdrawBtn", "faucetBtn"] : ["faucetBtn"])
      .forEach(id => $(id).disabled = false);
    if (!$("agentAddr").value) $("agentAddr").value = account;
    refreshSvrBalance();
    refreshProceeds();
    lookup();
  } catch (e) {
    wallet = null;
    logLine(`<span class="pill-err">${esc(c.name)}: ${esc(e.message)} — this chain needs a wallet that supports custom networks (MetaMask does; Phantom does not).</span>`);
  }
}

async function refreshSvrBalance() {
  if (!account) return;
  const bal = BigInt(await rpcRead(tokenAddr, SEL.balanceOf + encAddr(account)));
  $("svrBal").textContent = formatUnits(bal) + " " + tokenSymbol;
}

// ---- lookup ----
async function lookup() {
  const addr = $("agentAddr").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { logLine('<span class="pill-err">Enter a valid 0x address.</span>'); return; }
  currentAgent = addr;
  try {
    // No round trip: didHash is a pure function of the chain id and the address, which
    // is exactly why SigvaraIdentity derives it on chain at registration. This used to
    // be an eth_call for arithmetic the page could already do, and did.js now carries
    // the keccak256 that demo.js always had.
    const didHash = SigvaraDid.computeDidHash(addr, CHAIN_ID);
    currentDidHash = didHash;

    // Everything below depends only on didHash, so it goes in one request rather than
    // five sequential ones. Fee reads are appended only when the registry is live, so
    // the batch never carries a call to an address with no code.
    const reads = [
      { to: IDENTITY,   data: SEL.identities      + pad32(didHash) },
      { to: REPUTATION, data: SEL.getTotalScore   + pad32(didHash) },
      { to: REPUTATION, data: SEL.getPendingScore + pad32(didHash) },
      { to: REPUTATION, data: SEL.getReputation   + pad32(didHash) },
    ];
    reads.push(
      { to: STAKING, data: SEL.getStake             + pad32(didHash) },
      { to: STAKING, data: SEL.minimumStake },
      { to: STAKING, data: SEL.getPendingWithdrawal + pad32(didHash) },
      { to: STAKING, data: SEL.getSlashProposal     + pad32(didHash) },
      { to: STAKING, data: SEL.unbondingPeriod },
    );
    // Appended last, and only when live, so the staking positions above stay fixed.
    if (FEES_LIVE) reads.push(
      { to: FEES, data: SEL.balance   + pad32(didHash) },
      { to: FEES, data: SEL.isCovered + pad32(didHash) },
    );
    // What the bond panel needs beyond the core reads, appended after them in the same request
    // so the positions above stay fixed. Whether the suspension was a slash's, and how long a
    // dispute may sit unruled, exist on every version. The pause exists only on main.
    const extraReads = [
      { to: IDENTITY, data: SEL.slashSuspended + pad32(didHash) },
      { to: STAKING,  data: SEL.DISPUTE_RESOLUTION_PERIOD },
      { to: STAKING,  data: SEL.inflowsPausedUntil, optional: true },
      { to: IDENTITY, data: SEL.inflowsPausedUntil, optional: true },
    ];
    const answers = await rpcBatch([...reads, ...extraReads]);
    const [ident, scoreRaw, pendingRaw, rep,
           stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw,
           balRaw, coveredRaw] = answers.slice(0, reads.length);
    const extra = answers.slice(reads.length);

    const registeredAt = BigInt(word(ident, 4));
    const statusNum = Number(BigInt(word(ident, 3)));
    // Index matches SigvaraIdentity.AgentStatus. PendingBond means registered but
    // never bonded: not slashable, not scoreable, not yet an agent to rely on.
    const statusStr = ["Active", "Suspended", "Slashed", "awaiting bond"][statusNum] ?? "?";
    const bal = FEES_LIVE ? BigInt(balRaw) : 0n;
    const covered = FEES_LIVE && BigInt(coveredRaw) === 1n;
    $("didStr").textContent = `did:sigvara:${CHAIN_ID}:${addr}`;
    $("didHash").textContent = didHash;
    if (registeredAt !== 0n) {
      const score = BigInt(scoreRaw);
      $("regStatus").innerHTML = `<span class="pill-ok">yes — ${esc(statusStr)}</span>`;
      // A proposed score sits in a separate slot until its challenge window closes.
      // Showing only the finalized value reads as "no reputation" for any agent
      // whose first score is still open to challenge.
      $("score").innerHTML = `${score} / 100` + await pendingNote(pendingRaw);
      $("breakdown").innerHTML = FACTORS
        .map(([name, i, max]) => `${name} ${Number(BigInt(word(rep, i)))}/${max}`)
        .join(" &nbsp;·&nbsp; ")
        + ' &nbsp; <a href="docs/reputation">what is this?</a>';
    } else if (account) {
      $("regStatus").innerHTML = '<span class="pill-warn">not registered</span> <button id="regBtn" class="btn btn-secondary btn-inline-sm">Register this agent</button>';
      $("regBtn").onclick = registerAgentFlow;
      const regPausedUntil = pausedUntilOf(extra[3]);
      if (regPausedUntil > Math.floor(Date.now() / 1000)) {
        $("regBtn").disabled = true;
        $("regStatus").insertAdjacentHTML("beforeend", ` <span class="pill-warn">registration is paused until ${esc(fmtWhen(regPausedUntil))}</span>`);
      }
      $("score").textContent = "—";
      $("breakdown").textContent = "—";
    } else {
      $("regStatus").innerHTML = '<span class="pill-warn">not registered</span> — connect a wallet to register, or see <a href="docs/quickstart">Quickstart</a>';
      $("score").textContent = "—";
      $("breakdown").textContent = "—";
    }
    $("feeBal").textContent = FEES_LIVE ? formatUnits(bal) + " " + tokenSymbol : "n/a";
    $("covered").innerHTML = !FEES_LIVE
      ? '<span class="pill-warn">n/a, no fee registry on this deploy</span>'
      : covered ? '<span class="pill-ok">yes</span>' : '<span class="pill-err">no — deposit below</span>';
    renderStake({ ident, stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw, extra });
    $("agentInfo").classList.remove("u-hidden");
  } catch (e) {
    logLine(`<span class="pill-err">lookup failed: ${esc(e.message)}</span>`);
    // The Bond card still shows the previous agent and its buttons were enabled for that
    // agent, not for the address now in the box. Leave nothing live until a lookup succeeds.
    currentDidHash = null;
    stakeCtx = null;
    for (const id of ["bondBtn", "unbondBtn", "claimBtn", "disputeBtn", "suspendBtn", "reactivateBtn"]) $(id).disabled = true;
    $("stakeNote").textContent = "The lookup failed, so the card may still show the previous agent. Look up again.";
  }
}

// ---- bond ---------------------------------------------------------------------
//
// Every button here is enabled only when the chain would actually accept the call.
// depositStake and initiateWithdrawal are both operator-only, initiateWithdrawal also
// reverts while a slash is Pending or Disputed and while another withdrawal is already
// queued, and claimWithdrawal reverts before the unbonding period elapses. A button
// that looks live and then reverts inside the wallet teaches people the site is broken,
// which on the one page that moves money is an expensive thing to teach.

// Mirrors SigvaraStaking.SlashState.
const SLASH_STATES = ["None", "Pending", "Executed", "Cancelled", "Disputed"];
let stakeCtx = null;

function fmtDuration(sec) {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  if (d) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

// An optional read's answer: 0 when the contract does not have the function.
const pausedUntilOf = (raw) => (raw === null ? 0 : Number(BigInt(raw)));
const fmtWhen = (sec) => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

// What the slash proposal means for this agent, in words, with the dates that matter.
// The September contracts and main share the proposal struct but not who rules on a dispute:
// main's admin rules and cannot uphold before the deadline, the September committee rules and
// an upheld ruling slashes at once. Only main answers inflowsPausedUntil, which is how the
// page tells them apart (onMain).
function slashSummary({ slashState, initiatedAt, deadline, disputedAt, resolutionSecs, now, isOperator, onMain }) {
  if (slashState === 1) {
    if (now <= deadline) {
      return `<span class="pill-err">Pending</span>, filed ${esc(fmtWhen(initiatedAt))}. `
        + `${isOperator ? "You can" : "The operator can"} dispute it until ${esc(fmtWhen(deadline))} (${esc(fmtDuration(deadline - now))} left). `
        + "After that anyone can try to execute it.";
    }
    return `<span class="pill-err">Pending</span>: the challenge period ended ${esc(fmtWhen(deadline))}. `
      + "It can no longer be disputed, and anyone can try to execute it.";
  }
  if (slashState === 4) {
    const rules = onMain
      ? `The admin has to rule: upholding is possible only after ${esc(fmtWhen(deadline))}, and ruling for the agent reinstates it. `
      : "The slashing committee has to rule: upholding slashes the bond at once, and ruling for the agent reinstates it. ";
    return `<span class="pill-warn">Disputed</span> on ${esc(fmtWhen(disputedAt))}. ${rules}`
      + `If nobody rules, anyone can expire the dispute from ${esc(fmtWhen(disputedAt + resolutionSecs))}.`;
  }
  if (slashState === 2) return '<span class="pill-err">Executed</span>: the bond was slashed.';
  if (slashState === 3) return '<span class="pill-ok">Cancelled</span>: the last proposal was dropped and the bond is no longer frozen.';
  return "none";
}

function renderStake({ ident, stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw, extra }) {
  const operator   = "0x" + strip(word(ident, 0)).slice(24);
  const statusNum  = Number(BigInt(word(ident, 3)));
  const registered = BigInt(word(ident, 4)) !== 0n;
  const staked     = BigInt(stakeRaw);
  const minStake   = BigInt(minStakeRaw);
  const pendAmt    = BigInt(word(pendWRaw, 0));
  const claimAt    = Number(BigInt(word(pendWRaw, 1)));
  // getSlashProposal returns a dynamically encoded struct, because evidenceHash is
  // `bytes`. So word 0 is the offset to the tuple and the head starts at word 1:
  // state lands on word 5 and challengeDeadline on word 7. Verified against the live
  // contract rather than derived on paper.
  const slashState = Number(BigInt(word(slashRaw, 5)));
  const unbondSecs = Number(BigInt(unbondRaw));
  const now        = Math.floor(Date.now() / 1000);
  const isOperator = !!account && account.toLowerCase() === operator.toLowerCase();
  const frozen     = slashState === 1 || slashState === 4;
  const initiatedAt = Number(BigInt(word(slashRaw, 4)));
  const deadline    = Number(BigInt(word(slashRaw, 7)));
  const disputedAt  = Number(BigInt(word(slashRaw, 8)));
  const suspendedBySlash = BigInt(extra[0]) === 1n;
  const resolutionSecs   = Number(BigInt(extra[1]));
  const stakePausedUntil = pausedUntilOf(extra[2]);
  const paused           = stakePausedUntil > now;

  stakeCtx = { staked, minStake, pendAmt, claimAt, isOperator, frozen, statusNum, registered };

  $("stakeAmt").innerHTML = !registered ? "&mdash;"
    : `${formatUnits(staked)} ${esc(tokenSymbol)} ` + (staked >= minStake
        ? '<span class="pill-ok">at minimum</span>'
        : '<span class="pill-warn">below minimum, not scoreable</span>');
  $("stakeMin").textContent = `${formatUnits(minStake)} ${tokenSymbol}`;

  if (pendAmt > 0n) {
    const left = claimAt - now;
    $("stakeUnbond").innerHTML = `${formatUnits(pendAmt)} ${esc(tokenSymbol)} queued &mdash; ` + (left > 0
      ? `<span class="pill-warn">claimable in ${esc(fmtDuration(left))}</span>`
      : '<span class="pill-ok">claimable now</span>');
  } else {
    // Stating the period up front matters: 21 days is long enough that finding out
    // afterwards is a genuine surprise.
    $("stakeUnbond").innerHTML = `none &mdash; unbonding takes ${esc(fmtDuration(unbondSecs))}`;
  }

  // Status in words. A Suspended agent is suspended either by its operator, who can undo it,
  // or by a slash proposal, which only the proposal's outcome undoes. The two look the same
  // in `identities` and mean opposite things to the person holding the bond.
  if (!registered) {
    $("stakeStatus").innerHTML = "&mdash;";
  } else if (statusNum === 1) {
    $("stakeStatus").innerHTML = suspendedBySlash
      ? '<span class="pill-warn">Suspended by a slash proposal</span>: reinstated only if the proposal is dropped'
      : `<span class="pill-warn">Suspended by its operator</span>: ${isOperator ? "you can reactivate it" : "only the operator can reactivate it"}`;
  } else {
    $("stakeStatus").innerHTML = ['<span class="pill-ok">Active</span>', "", '<span class="pill-err">Slashed</span>', '<span class="pill-warn">Awaiting bond</span>'][statusNum] ?? "?";
  }
  $("slashInfo").innerHTML = registered
    ? slashSummary({ slashState, initiatedAt, deadline, disputedAt, resolutionSecs, now, isOperator, onMain: extra[2] !== null })
    : "&mdash;";
  $("pauseNote").innerHTML = paused
    ? `<span class="pill-warn">The guardian has paused deposits until ${esc(fmtWhen(stakePausedUntil))}.</span> Bonding is refused until then; unbonding, disputes and claims still work.`
    : "";

  let note, why = null;
  if (!registered)            { note = "Register the agent first, above."; why = "unregistered"; }
  else if (statusNum === 2)   { note = "This agent has been slashed. Its bond cannot be topped up."; why = "slashed"; }
  else if (!account)          { note = "Connect a wallet to bond."; why = "no wallet"; }
  else if (!isOperator)       { note = `Only the operator wallet <code>${esc(operator.slice(0, 10))}…</code> can bond or withdraw for this agent.`; why = "not operator"; }
  else if (frozen)            { note = `A slash proposal is <b>${esc(SLASH_STATES[slashState])}</b>. The bond is frozen until it resolves &mdash; withdrawing is blocked, topping up is not.`; }
  else if (statusNum === 1 && staked >= minStake) { note = "Suspended by its operator. It is still scored, but anyone who checks status will refuse it until you reactivate it."; }
  else if (staked < minStake) { note = `Bond at least ${formatUnits(minStake - staked)} more ${esc(tokenSymbol)} to make this agent scoreable.`; }
  else                        { note = "Bonded and scoreable."; }
  $("stakeNote").innerHTML = frozen ? `<span class="pill-err">${note}</span>` : note;

  const canWrite = isOperator && registered && statusNum !== 2;
  $("bondBtn").disabled   = !canWrite || paused;
  $("unbondBtn").disabled = !canWrite || staked === 0n || pendAmt > 0n || frozen;
  $("claimBtn").disabled  = !canWrite || pendAmt === 0n || now < claimAt;
  // Disputing is the operator's only answer to a slash proposal and the window is short, so
  // the button is live exactly while the contract would accept it: Pending, deadline not passed.
  $("disputeBtn").disabled    = !(isOperator && slashState === 1 && now <= deadline);
  $("suspendBtn").disabled    = !(canWrite && statusNum === 0 && !frozen);
  $("reactivateBtn").disabled = !(canWrite && statusNum === 1 && !suspendedBySlash && staked >= minStake);
  void why;
}

async function bondStake() {
  try {
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("stakeAmount").value);
    const allowance = BigInt(await rpcRead(tokenAddr, SEL.allowance + encAddr(account) + encAddr(STAKING)));
    if (allowance < amt) {
      logLine(`approving ${formatUnits(amt)} ${esc(tokenSymbol)} for the staking contract…`);
      await sendTx(tokenAddr, SEL.approve + encAddr(STAKING) + encUint(amt));
    }
    logLine(`bonding ${formatUnits(amt)} ${esc(tokenSymbol)}…`);
    await sendTx(STAKING, SEL.depositStake + pad32(currentDidHash) + encUint(amt));
    await Promise.all([lookup(), refreshSvrBalance()]);
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function beginUnbond() {
  try {
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("stakeAmount").value);
    // Said before the wallet opens, not after. The tokens are locked for the unbonding
    // period once this is sent: it is the least reversible thing the page can do.
    if (stakeCtx && amt > stakeCtx.staked) {
      logLine(`<span class="pill-err">${formatUnits(stakeCtx.staked)} ${esc(tokenSymbol)} is bonded; that is more than can be unbonded.</span>`);
      return;
    }
    if (stakeCtx && stakeCtx.staked - amt < stakeCtx.minStake) {
      if (stakeCtx.statusNum === 0) {
        // The contract refuses this for an Active agent (InsufficientStake), on the September
        // build as well as main. Saying so here saves a wallet prompt that can only revert.
        const room = stakeCtx.staked > stakeCtx.minStake ? stakeCtx.staked - stakeCtx.minStake : 0n;
        logLine(`<span class="pill-err">An active agent cannot unbond below the minimum. At most ${formatUnits(room)} ${esc(tokenSymbol)} can come out while it is Active; to take out more, suspend the agent first.</span>`);
        return;
      }
      logLine('<span class="pill-warn">this takes the bond below the minimum, so the agent cannot be reactivated until it is bonded back to the minimum</span>');
    }
    logLine(`starting unbonding of ${formatUnits(amt)} ${esc(tokenSymbol)}…`);
    await sendTx(STAKING, SEL.initiateWithdrawal + pad32(currentDidHash) + encUint(amt));
    await lookup();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function claimUnbond() {
  try {
    if (!currentDidHash) await lookup();
    logLine("claiming unbonded stake…");
    await sendTx(STAKING, SEL.claimWithdrawal + pad32(currentDidHash));
    await Promise.all([lookup(), refreshSvrBalance()]);
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function disputeSlash() {
  try {
    if (!currentDidHash) await lookup();
    logLine("disputing the slash proposal (the bond stays frozen and the admin has to rule on it)…");
    await sendTx(STAKING, SEL.disputeSlash + pad32(currentDidHash));
    await lookup();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

// 1 = Suspended, 0 = Active. The contract lets an operator suspend its own agent at any time,
// and reactivate it only with the minimum bonded and no slash proposal behind the suspension.
async function setStatus(code, verb) {
  try {
    if (!currentDidHash) await lookup();
    logLine(`${verb} the agent…`);
    await sendTx(IDENTITY, SEL.updateStatus + pad32(currentDidHash) + encUint(BigInt(code)));
    await lookup();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

// Slash proceeds belong to the connected wallet (a victim or a reporter), not to the looked-up
// agent, so they have their own read and their own button.
async function refreshProceeds() {
  if (!account) return;
  try {
    const owed = BigInt(await rpcRead(STAKING, SEL.claimable + encAddr(account)));
    $("proceeds").textContent = `${formatUnits(owed)} ${tokenSymbol}`;
    $("proceedsBtn").disabled = owed === 0n;
  } catch (e) { $("proceeds").textContent = "unavailable"; }
}
async function claimProceeds() {
  try {
    logLine("claiming slash proceeds…");
    await sendTx(STAKING, SEL.claimSlashProceeds);
    await Promise.all([refreshProceeds(), refreshSvrBalance()]);
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

// Returns markup describing a score that is proposed but not yet finalized,
// or an empty string when nothing is pending.
// Takes the pending blob the lookup already fetched, rather than fetching it again.
async function pendingNote(raw) {
  try {
    if (BigInt(word(raw, 8)) !== 1n) return "";
    const total = FACTORS.reduce((sum, [, i]) => sum + Number(BigInt(word(raw, i))), 0);
    // main stores the time a proposal becomes final (word 11); the September contracts return ten
    // words and the time is the proposal's plus the window as it stands now.
    const stored = strip(raw).length >= 12 * 64 ? Number(BigInt(word(raw, 11))) : 0;
    const opensAt = stored || Number(BigInt(word(raw, 7))) + await getChallengeWindow();
    const when = new Date(opensAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    return ` <span class="pill-warn">${total} proposed, finalizes after ${esc(when)} UTC</span>`;
  } catch (_) {
    return "";  // never let this block the score itself
  }
}

// ---- actions ----
async function registerAgentFlow() {
  try {
    if (!wallet || !account) { logLine('<span class="pill-err">Connect a wallet first.</span>'); return; }
    // Check eligibility BEFORE generating anything. Registration needs a signature from
    // the agent address itself, so the browser can only do this for the wallet it is
    // connected to. This check used to sit after the keypair was generated AND written to
    // the user's disk, so looking up someone else's address left them holding a file
    // containing a private key for a registration that could never happen.
    if (currentAgent.toLowerCase() !== account.toLowerCase()) {
      logLine('<span class="pill-err">Registration needs a signature from the agent address, '
        + 'so this button can only register the wallet you are connected with. '
        + 'Connect the wallet for ' + esc(currentAgent) + ', or use the SDK flow in the '
        + '<a href="docs/quickstart">Quickstart</a> to register an agent whose key you hold '
        + 'separately from the operator wallet.</span>');
      return;
    }

    logLine("generating Ed25519 identity keypair in your browser…");
    let kp;
    try {
      kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    } catch (_) {
      logLine('<span class="pill-err">This browser cannot generate Ed25519 keys — use the SDK flow in the Quickstart instead.</span>');
      return;
    }
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pubHex = [...pub].map(b => b.toString(16).padStart(2, "0")).join("");
    // Export the private key as PKCS8, falling back to JWK.
    //
    // Ed25519 generateKey is supported in Chrome 137+, Firefox 129+ and Safari 17+, but
    // MDN carries a note that exportKey handles Ed25519 for "raw" and not "pkcs8". This
    // path was only ever exercised in Chromium, where pkcs8 works and returns 48 bytes.
    // Rather than trust a compatibility table for browsers nobody here can run, take
    // whichever envelope the browser will actually produce. It is the same key material,
    // and nothing reads this file programmatically: it exists for the operator to keep.
    let keyFormat = "PKCS8 base64";
    let keyText;
    try {
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
      keyText = btoa(String.fromCharCode(...pkcs8));
    } catch (_) {
      keyFormat = "JWK";
      keyText = JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));
      logLine("this browser does not export PKCS8 for Ed25519; saving the key as JWK instead");
    }
    const blob = new Blob([
      `Sigvara agent identity key (Ed25519, private key as ${keyFormat})\n` +
      `agent:      ${currentAgent}\n` +
      `did:        did:sigvara:${CHAIN_ID}:${currentAgent}\n` +
      `public key: 0x${pubHex}\n` +
      `private key (KEEP SECRET — it signs auth challenges for this agent):\n${keyText}\n`,
    ], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sigvara-agent-key-${currentAgent.slice(0, 10)}.txt`;
    a.click();
    logLine(`key file downloaded — keep it safe. pubkey 0x${pubHex.slice(0, 16)}…`);
    logLine("signing proof of control for this address…");
    const digest = await rpcRead(
      IDENTITY,
      SEL.registrationDigest + encAddr(currentAgent) + encAddr(account) + pubHex
    );
    // personal_sign applies the EIP-191 prefix, which is the one the contract expects.
    const signature = await wallet.request({
      method: "personal_sign",
      params: [digest, account],
    });

    logLine("registering agent (your wallet becomes the operator)…");
    await sendTx(
      IDENTITY,
      // agentAddress, ed25519PubKey, signature -> three head slots.
      SEL.registerAgent + encAddr(currentAgent) + pubHex + encBytes(signature, 3)
    );
    await lookup();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function deposit() {
  try {
    if (!FEES_LIVE) { logLine('<span class="pill-err">No fee registry on this deployment.</span>'); return; }
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("amount").value);
    const allowance = BigInt(await rpcRead(tokenAddr, SEL.allowance + encAddr(account) + encAddr(FEES)));
    if (allowance < amt) {
      logLine(`approving ${formatUnits(amt)} ${esc(tokenSymbol)}…`);
      await sendTx(tokenAddr, SEL.approve + encAddr(FEES) + encUint(amt));
    }
    logLine(`depositing ${formatUnits(amt)} ${esc(tokenSymbol)} for agent…`);
    await sendTx(FEES, SEL.depositFor + pad32(currentDidHash) + encUint(amt));
    await Promise.all([lookup(), refreshSvrBalance()]);
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}
async function withdrawFees() {
  try {
    if (!FEES_LIVE) { logLine('<span class="pill-err">No fee registry on this deployment.</span>'); return; }
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("amount").value);
    logLine(`withdrawing ${formatUnits(amt)} ${esc(tokenSymbol)} (operator only)…`);
    await sendTx(FEES, SEL.withdraw + pad32(currentDidHash) + encUint(amt));
    await Promise.all([lookup(), refreshSvrBalance()]);
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}
async function faucet() {
  try {
    logLine(`requesting 1,000 ${esc(tokenSymbol)} from faucet…`);
    await sendTx(tokenAddr, SEL.faucet + encUint(1000n * 10n ** tokenDecimals));
    await refreshSvrBalance();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)} (testnet faucet only, has a cooldown)</span>`); }
}

// ---- init ----
(async function init() {
  if (FEES_LIVE) {
    $("feesLink").href = `${EXPLORER}/address/${FEES}`;
  } else {
    $("feesLink").removeAttribute("href");
    $("feesLink").innerHTML = "<code>not deployed</code>";
  }
  $("connectBtn").onclick = connect;
  $("lookupBtn").onclick = lookup;
  $("depositBtn").onclick = deposit;
  $("withdrawBtn").onclick = withdrawFees;
  $("faucetBtn").onclick = faucet;
  $("bondBtn").onclick = bondStake;
  $("unbondBtn").onclick = beginUnbond;
  $("claimBtn").onclick = claimUnbond;
  $("disputeBtn").onclick = disputeSlash;
  $("suspendBtn").onclick = () => setStatus(1, "suspending");
  $("reactivateBtn").onclick = () => setStatus(0, "reactivating");
  $("proceedsBtn").onclick = claimProceeds;
  try {
    // fee token metadata comes from the chain: SVR faucet token on testnet,
    // USDC/WETH at mainnet — nothing on this page assumes a native token
    // Without a registry to read it from, the faucet token comes from the
    // deployment constant instead.
    tokenAddr = FEES_LIVE ? "0x" + strip(await rpcRead(FEES, SEL.svr)).slice(24) : SVR;
    tokenSymbol = decodeString(await rpcRead(tokenAddr, SEL.symbol));
    tokenDecimals = BigInt(await rpcRead(tokenAddr, SEL.decimals));
    // on testnet, make it impossible to read the faucet token as a real asset
    if (CHAIN_ID === 5042002) tokenSymbol = "test " + tokenSymbol;
    $("amount").placeholder = `amount in ${esc(tokenSymbol)}, e.g. 100`;
    $("faucetBtn").textContent = `Get 1,000 ${esc(tokenSymbol)}`;
    if (FEES_LIVE) {
      const fee = BigInt(await rpcRead(FEES, SEL.epochFee));
      $("feeNow").textContent = `${formatUnits(fee)} ${esc(tokenSymbol)}/epoch`;
      $("feeNote").textContent = (fee === 0n ? "(bootstrap: scoring is free, gating disabled — " : "(")
        + "fees use a valueless testnet faucet token, not a tradeable asset)";
    } else {
      $("feeNow").textContent = "none";
      $("feeNote").textContent = "(no fee registry in this deploy, so scoring is free and nothing is charged)";
    }
  } catch (e) {
    $("feeNow").textContent = "unavailable";
    logLine(`<span class="pill-err">RPC read failed: ${esc(e.message)}</span>`);
  }
})();
