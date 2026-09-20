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
  svr: "0x0b5ae4d9", symbol: "0x95d89b41", decimals: "0x313ce567", registerAgent: "0x367260d7", registrationDigest: "0x9aad085f",
  getReputation: "0xd14519d2", getPendingScore: "0x56cf76e7", challengeWindow: "0x861a1412",
  // SigvaraStaking. Verified with `cast sig`, not guessed: getStake and minimumStake
  // match the pair testnet.js already uses against the same deployment.
  depositStake: "0xbeb78671", initiateWithdrawal: "0xa3d6f72b", claimWithdrawal: "0x8e88eccc",
  getStake: "0xe765c122", minimumStake: "0xec5ffac2", getPendingWithdrawal: "0xd0fe00db",
  unbondingPeriod: "0x6cf6d675", getSlashProposal: "0xc984f6f8",
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
  el.innerHTML += (el.innerHTML ? "\n" : "") + html;
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
  return calls.map((_, i) => {
    const r = byId.get(i);
    if (!r || r.error) throw new Error(r?.error?.message ?? "missing result in batch");
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
    const [ident, scoreRaw, pendingRaw, rep,
           stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw,
           balRaw, coveredRaw] = await rpcBatch(reads);

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
    renderStake({ ident, stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw });
    $("agentInfo").classList.remove("u-hidden");
  } catch (e) {
    logLine(`<span class="pill-err">lookup failed: ${esc(e.message)}</span>`);
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

function renderStake({ ident, stakeRaw, minStakeRaw, pendWRaw, slashRaw, unbondRaw }) {
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

  let note, why = null;
  if (!registered)            { note = "Register the agent first, above."; why = "unregistered"; }
  else if (statusNum === 2)   { note = "This agent has been slashed. Its bond cannot be topped up."; why = "slashed"; }
  else if (!account)          { note = "Connect a wallet to bond."; why = "no wallet"; }
  else if (!isOperator)       { note = `Only the operator wallet <code>${esc(operator.slice(0, 10))}…</code> can bond or withdraw for this agent.`; why = "not operator"; }
  else if (frozen)            { note = `A slash proposal is <b>${esc(SLASH_STATES[slashState])}</b>. The bond is frozen until it resolves &mdash; withdrawing is blocked, topping up is not.`; }
  else if (staked < minStake) { note = `Bond at least ${formatUnits(minStake - staked)} more ${esc(tokenSymbol)} to make this agent scoreable.`; }
  else                        { note = "Bonded and scoreable."; }
  $("stakeNote").innerHTML = frozen ? `<span class="pill-err">${note}</span>` : note;

  const canWrite = isOperator && registered && statusNum !== 2;
  $("bondBtn").disabled   = !canWrite;
  $("unbondBtn").disabled = !canWrite || staked === 0n || pendAmt > 0n || frozen;
  $("claimBtn").disabled  = !canWrite || pendAmt === 0n || now < claimAt;
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
    await lookup(); await refreshSvrBalance();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function beginUnbond() {
  try {
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("stakeAmount").value);
    // Said before the wallet opens, not after. Dropping below the minimum suspends the
    // agent and stops it being scored, and the tokens are locked for the unbonding
    // period either way — this is the least reversible thing the page can do.
    if (stakeCtx && stakeCtx.staked - amt < stakeCtx.minStake) {
      logLine('<span class="pill-warn">this takes the bond below the minimum — the agent stops being scoreable until it is topped back up</span>');
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
    await lookup(); await refreshSvrBalance();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

// Returns markup describing a score that is proposed but not yet finalized,
// or an empty string when nothing is pending.
// Takes the pending blob the lookup already fetched, rather than fetching it again.
async function pendingNote(raw) {
  try {
    if (BigInt(word(raw, 8)) !== 1n) return "";
    const total = FACTORS.reduce((sum, [, i]) => sum + Number(BigInt(word(raw, i))), 0);
    const opensAt = Number(BigInt(word(raw, 7))) + await getChallengeWindow();
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
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pkcs8b64 = btoa(String.fromCharCode(...pkcs8));
    const blob = new Blob([
      `Sigvara agent identity key (Ed25519, private key as PKCS8 base64)\n` +
      `agent:      ${currentAgent}\n` +
      `did:        did:sigvara:${CHAIN_ID}:${currentAgent}\n` +
      `public key: 0x${pubHex}\n` +
      `private key (KEEP SECRET — it signs auth challenges for this agent):\n${pkcs8b64}\n`,
    ], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sigvara-agent-key-${currentAgent.slice(0, 10)}.txt`;
    a.click();
    logLine(`key file downloaded — keep it safe. pubkey 0x${pubHex.slice(0, 16)}…`);
    // Registration requires a signature from the agent address itself, so the browser
    // can only do this for the wallet it is connected to. Anything else needs the SDK,
    // where the agent's key can be supplied separately.
    if (currentAgent.toLowerCase() !== account.toLowerCase()) {
      logLine('<span class="pill-err">Registration needs a signature from the agent address. '
        + 'Connect the wallet for ' + esc(currentAgent) + ', or use the SDK flow in the '
        + '<a href="docs/quickstart">Quickstart</a> to sign with its key separately.</span>');
      return;
    }

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
    await lookup(); await refreshSvrBalance();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}
async function withdrawFees() {
  try {
    if (!FEES_LIVE) { logLine('<span class="pill-err">No fee registry on this deployment.</span>'); return; }
    if (!currentDidHash) await lookup();
    const amt = parseUnits($("amount").value);
    logLine(`withdrawing ${formatUnits(amt)} ${esc(tokenSymbol)} (operator only)…`);
    await sendTx(FEES, SEL.withdraw + pad32(currentDidHash) + encUint(amt));
    await lookup(); await refreshSvrBalance();
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
