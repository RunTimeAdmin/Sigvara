"use strict";
// No external libraries on purpose: a CDN script on a wallet page is a supply-chain risk.
// Reads go straight to the public RPC; writes go through the user's wallet.

const CHAIN_ID = 5042002, CHAIN_HEX = "0x4cef52";
const RPC = "https://rpc.testnet.arc.io";
const EXPLORER = "https://explorer.testnet.arc.io";
// Fill these from deployments/5042002.json after the Arc testnet deploy.
const IDENTITY   = "0x0000000000000000000000000000000000000000";
const REPUTATION = "0x0000000000000000000000000000000000000000";
const FEES       = "0x0000000000000000000000000000000000000000";
const SVR       = "0x0000000000000000000000000000000000000000";

// 4-byte selectors, precomputed with `cast sig`
const SEL = {
  computeDidHash: "0xc5d4962d", identities: "0x81638e9b", getTotalScore: "0x2522be94",
  epochFee: "0x41e4cfa8", balance: "0x89eba421", isCovered: "0xcb607e4f",
  depositFor: "0x1da1bbfb", withdraw: "0x040cf020",
  approve: "0x095ea7b3", allowance: "0xdd62ed3e", balanceOf: "0x70a08231", faucet: "0x57915897",
  svr: "0x0b5ae4d9", symbol: "0x95d89b41", decimals: "0x313ce567", registerAgent: "0xdb24d4ba",
  getReputation: "0xd14519d2",
};
// factor label, on-chain word index, and max — mirrors SigvaraReputation.ReputationData
const FACTORS = [
  ["fee", 0, 30], ["success", 1, 25], ["age", 2, 20],
  ["external", 3, 15], ["community", 4, 5], ["propagation", 5, 5],
];

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
async function sendTx(to, data) {
  const hash = await wallet.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to, data }],
  });
  logLine(`tx sent ${txLink(hash)} — waiting…`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2500));
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
    ["depositBtn", "withdrawBtn", "faucetBtn"].forEach(id => $(id).disabled = false);
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
    const didHash = await rpcRead(IDENTITY, SEL.computeDidHash + encAddr(addr));
    currentDidHash = didHash;
    const ident = await rpcRead(IDENTITY, SEL.identities + pad32(didHash));
    const registeredAt = BigInt(word(ident, 4));
    const statusNum = Number(BigInt(word(ident, 3)));
    const statusStr = ["Active", "Suspended", "Slashed"][statusNum] ?? "?";
    const bal = BigInt(await rpcRead(FEES, SEL.balance + pad32(didHash)));
    const covered = BigInt(await rpcRead(FEES, SEL.isCovered + pad32(didHash))) === 1n;
    $("didStr").textContent = `did:sigvara:${CHAIN_ID}:${addr}`;
    $("didHash").textContent = didHash;
    if (registeredAt !== 0n) {
      const score = BigInt(await rpcRead(REPUTATION, SEL.getTotalScore + pad32(didHash)));
      $("regStatus").innerHTML = `<span class="pill-ok">yes — ${esc(statusStr)}</span>`;
      $("score").textContent = `${score} / 100`;
      const rep = await rpcRead(REPUTATION, SEL.getReputation + pad32(didHash));
      $("breakdown").innerHTML = FACTORS
        .map(([name, i, max]) => `${name} ${Number(BigInt(word(rep, i)))}/${max}`)
        .join(" &nbsp;·&nbsp; ")
        + ' &nbsp; <a href="docs/reputation.html">what is this?</a>';
    } else if (account) {
      $("regStatus").innerHTML = '<span class="pill-warn">not registered</span> <button id="regBtn" class="btn btn-secondary btn-inline-sm">Register this agent</button>';
      $("regBtn").onclick = registerAgentFlow;
      $("score").textContent = "—";
      $("breakdown").textContent = "—";
    } else {
      $("regStatus").innerHTML = '<span class="pill-warn">not registered</span> — connect a wallet to register, or see <a href="docs/quickstart.html">Quickstart</a>';
      $("score").textContent = "—";
      $("breakdown").textContent = "—";
    }
    $("feeBal").textContent = formatUnits(bal) + " " + tokenSymbol;
    $("covered").innerHTML = covered ? '<span class="pill-ok">yes</span>' : '<span class="pill-err">no — deposit below</span>';
    $("agentInfo").classList.remove("u-hidden");
  } catch (e) {
    logLine(`<span class="pill-err">lookup failed: ${esc(e.message)}</span>`);
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
    logLine("registering agent (your wallet becomes the operator)…");
    await sendTx(IDENTITY, SEL.registerAgent + encAddr(currentAgent) + pubHex);
    await lookup();
  } catch (e) { logLine(`<span class="pill-err">${esc(e.message)}</span>`); }
}

async function deposit() {
  try {
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
  $("feesLink").href = `${EXPLORER}/address/${FEES}`;
  $("connectBtn").onclick = connect;
  $("lookupBtn").onclick = lookup;
  $("depositBtn").onclick = deposit;
  $("withdrawBtn").onclick = withdrawFees;
  $("faucetBtn").onclick = faucet;
  try {
    // fee token metadata comes from the chain: SVR faucet token on testnet,
    // USDC/WETH at mainnet — nothing on this page assumes a native token
    tokenAddr = "0x" + strip(await rpcRead(FEES, SEL.svr)).slice(24);
    tokenSymbol = decodeString(await rpcRead(tokenAddr, SEL.symbol));
    tokenDecimals = BigInt(await rpcRead(tokenAddr, SEL.decimals));
    // on testnet, make it impossible to read the faucet token as a real asset
    if (CHAIN_ID === 5042002) tokenSymbol = "test " + tokenSymbol;
    $("amount").placeholder = `amount in ${esc(tokenSymbol)}, e.g. 100`;
    $("faucetBtn").textContent = `Get 1,000 ${esc(tokenSymbol)}`;
    const fee = BigInt(await rpcRead(FEES, SEL.epochFee));
    $("feeNow").textContent = `${formatUnits(fee)} ${esc(tokenSymbol)}/epoch`;
    $("feeNote").textContent = (fee === 0n ? "(bootstrap: scoring is free, gating disabled — " : "(")
      + "fees use a valueless testnet faucet token, not a tradeable asset)";
  } catch (e) {
    $("feeNow").textContent = "unavailable";
    logLine(`<span class="pill-err">RPC read failed: ${esc(e.message)}</span>`);
  }
})();
