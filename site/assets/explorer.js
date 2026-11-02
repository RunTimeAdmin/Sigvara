/* Shared reads for the explorer pages: agents, operators and slashes.
 *
 * Reads only. No wallet, nothing signed, no external library (see app.js for why). Each page
 * says which source every fact came from:
 *   - the chain, over the public RPC: scores, stakes, bonds and the committed evidence roots.
 *   - the Arc explorer's log index: which agents registered, which operators bonded and every
 *     slash. The RPC answers eth_getLogs over at most 10,000 blocks, and the explorer answers a
 *     contract's whole history in one request (it allows ten an hour from one address, so
 *     answers are kept in the tab for a few minutes).
 *   - the operators' own public endpoints: the primary's /evidence and /health, the checker's
 *     /health and /divergence.
 * Everything that comes back is untrusted input: hex is shape-checked before it goes into a
 * link, and text is escaped before it goes into the page.
 *
 * The evidence check at the bottom rebuilds a Merkle root exactly as oracle/merkle.js does, so a
 * visitor can recompute what the oracle committed to instead of taking its word.
 * oracle/explorer-merkle.test.js holds the two to the same answers.
 */
(function (root) {
  "use strict";
  const Did = root.SigvaraDid || (typeof require === "function" ? require("./did.js") : null);

  const CHAIN_ID = 5042002;
  const RPC = "https://rpc.testnet.arc.io";
  const EXPLORER = "https://explorer.testnet.arc.io";
  const EXPLORER_API = EXPLORER + "/api";
  const PRIMARY = "https://oracle.sigvara.xyz";
  const CHECKER = "https://checker.sigvara.xyz";
  const SOURCE = "https://github.com/RunTimeAdmin/Sigvara";
  // From deployments/5042002.json; scripts/check-docs.mjs checks each one against it.
  const IDENTITY    = "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd";
  const REPUTATION  = "0x6603C96275e85F724Cdf74666b399365e4cA29ed";
  const STAKING     = "0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B";
  const ORACLE_BOND = "0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171";
  const SVR         = "0x41De2D6D55318e197a00E8f5B496eA2790e23E6c";
  const DEPLOYER    = "0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811";
  // The two ORACLE_ROLE holders, read from RoleGranted on the reputation proxy on 1 Nov 2026
  // (none revoked). Both are run by the Sigvara team. Used to name them; any other address is
  // shown bare.
  const OPERATORS = {
    "0x6352b8ffbc3bdd182512ce59ef69d1b155fb3943": "primary",
    "0x989aabd69631f81a6b2c8ce508c32aa219ec172d": "checker",
  };

  // 4-byte selectors, checked against src/ by scripts/check-docs.mjs.
  const SEL = {
    identities: "0x81638e9b", getTotalScore: "0x2522be94", getEarnedScore: "0x9d46deb8",
    evidenceRoots: "0x42201823", getPendingScore: "0x56cf76e7", verifyEvidence: "0x7f168792",
    getStake: "0xe765c122", operators: "0x13e7c9d8", bondOf: "0x72d2b6c0", signerOf: "0x5b5175d5",
    bondAmount: "0x80f323a7", slashBeneficiary: "0xf0ef6c53", initiateSlash: "0x6c05a5d7",
  };
  // topic0 of each event the pages read, and the contract that emits it. scripts/check-docs.mjs
  // checks every topic against its signature, and every current one against that contract.
  // SlashExecuted carried a reporter's share until the staking upgrade of 2 November 2026; the
  // slash drill of October emitted that form.
  const EVENTS = [
    { name: "AgentRegistered", sig: "AgentRegistered(bytes32,address,address,bytes32)", topic: "0x05721be61cc3d7a6bf132adf5eaa7898a92db50c5db47b35e8ade18b06423281", contract: "identity" },
    { name: "SlashInitiated", sig: "SlashInitiated(bytes32,address,address,uint256)", topic: "0x68a6dcb0be51611092b43c97ef36088f9f1c0905c37d8170b379a590d8a50f01", contract: "staking" },
    { name: "SlashDisputed", sig: "SlashDisputed(bytes32,address)", topic: "0x58fadd7ae5483f79dd4d61a778aa5c239fb4d42bef831f52807cd1ec32d9999a", contract: "staking" },
    { name: "SlashExecuted", sig: "SlashExecuted(bytes32,uint256,uint256)", topic: "0x2c8595d6ea47659522ccbb27b6d576b6f1aa1fa9b540727b7e4292546f78af8d", contract: "staking" },
    { name: "SlashExecuted", sig: "SlashExecuted(bytes32,uint256,uint256,uint256)", topic: "0xb9b9de619e4c7ea6d0ad10ba289318d8a1e7867d259fbc134f20edd670a1f927", contract: "staking", legacy: true },
    { name: "SlashCancelled", sig: "SlashCancelled(bytes32,address)", topic: "0xa145389a32859b05fc0cbe608258f7aa9b97768c1ac649852045ccd3eaa7721f", contract: "staking" },
    { name: "SlashVetoed", sig: "SlashVetoed(bytes32,address)", topic: "0x3298ffdd2ca544441ae4c9a46c47e9c10a2dd84b757a2af44e05f25aae7e2f78", contract: "staking" },
    { name: "BondDeposited", sig: "BondDeposited(address,uint256,uint256)", topic: "0x53709ba3cdfc6888ee4e1f05692566dfc3446e917fd4402db50e328307e6b393", contract: "oracleBond" },
    { name: "OperatorAdmitted", sig: "OperatorAdmitted(address)", topic: "0xaa9cbf0bc572eb1a0df2215538cbbb3586167b11226cfb14de8a8766ac1427a5", contract: "oracleBond" },
    { name: "OperatorSlashed", sig: "OperatorSlashed(address,uint256,uint256,bool)", topic: "0x00f6121e897f523b2a3ff9999f75c7673f9da51b3cb15d7c7cb3d6665f76fd82", contract: "oracleBond" },
    { name: "UnbondInitiated", sig: "UnbondInitiated(address,uint256)", topic: "0xa93372deb773115a534e3bad69f44e679f28e1ecce9d205f3ab2a6d3f200c5bf", contract: "oracleBond" },
    { name: "BondWithdrawn", sig: "BondWithdrawn(address,uint256)", topic: "0x0d41118e36df44efb77a471fc49fb9c0be0406d802ef95520e9fbf606e65b455", contract: "oracleBond" },
    { name: "OperatorRemoved", sig: "OperatorRemoved(address)", topic: "0x80c0b871b97b595b16a7741c1b06fed0c6f6f558639f18ccbce50724325dc40d", contract: "oracleBond" },
    { name: "SignerSet", sig: "SignerSet(address,address)", topic: "0xb0604c365feafa080c833b6f6814d321a7561528e696ac2a112c2a0231b0ed35", contract: "oracleBond" },
    { name: "SignerCleared", sig: "SignerCleared(address,address)", topic: "0x212e84602a5d1c033865368f4d65df0cb4c602316ea35d75f8c8ba01d496cc00", contract: "oracleBond" },
  ];
  // The bond contract's events, read as one set so the operators and slashes pages share one
  // cached explorer request.
  const BOND_EVENTS = ["BondDeposited", "OperatorAdmitted", "OperatorSlashed", "UnbondInitiated", "BondWithdrawn", "OperatorRemoved", "SignerSet", "SignerCleared"];
  // Index matches SigvaraIdentity.AgentStatus.
  const STATUS = ["Active", "Suspended", "Slashed", "awaiting bond"];
  // Index matches SigvaraOracleBond.Status.
  const BOND_STATUS = ["not bonded", "bonded", "active", "exiting"];
  const ZERO32 = "0x" + "0".repeat(64);
  // The explorer's getLogs returns at most this many rows. A full page means there may be more.
  const EXPLORER_PAGE = 1000;
  const LOGS_TTL_MS = 10 * 60 * 1000;
  const EXPLORER_TIMEOUT_MS = 60000;
  // What a card says while it waits on the explorer.
  const READING_HISTORY = '<p class="netnote">Reading the contract\'s history from the Arc explorer. It can take up to a minute.</p>';

  // ---- small helpers ----
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
  const pad32 = (h) => strip(h).toLowerCase().padStart(64, "0");
  const word = (data, i) => "0x" + strip(data).slice(i * 64, (i + 1) * 64);
  const wordAddr = (data, i) => "0x" + strip(word(data, i)).slice(24);
  const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
  const isHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
  const topicAddr = (t) => "0x" + String(t || "").slice(26).toLowerCase();

  // Times come from outside services, and toISOString throws on any time a Date cannot hold.
  function fmtWhen(sec) {
    const d = new Date(Number(sec) * 1000);
    return sec > 0 && !Number.isNaN(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "an unknown time";
  }
  // 18 decimals: the SVR test token, which bonds, stakes and the evidence amounts are in.
  function fmtSvr(raw) {
    try {
      const v = BigInt(raw);
      const i = v / 10n ** 18n, f = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 2).replace(/0+$/, "");
      return (f ? `${i}.${f}` : i.toLocaleString("en-US")) + " SVR";
    } catch (_) { return "?"; }
  }
  const txLink = (h) => (isHash(h)
    ? `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener"><code>${short(h)}</code></a>` : "");
  const addrLink = (a) => (isAddr(a)
    ? `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener"><code>${short(a)}</code></a>` : "?");
  const rootCode = (r) => (!r ? "none" : same(r, ZERO32) ? "<code>0x0</code> (none)" : `<code title="${esc(r)}">${esc(short(r))}</code>`);
  const commitLink = (c) => (/^[0-9a-f]{40}$/.test(c || "")
    ? `<a href="${SOURCE}/commit/${c}" target="_blank" rel="noopener"><code>${c.slice(0, 7)}</code></a>` : "unknown");
  function whoIs(a) {
    if (!isAddr(a)) return "?";
    const name = OPERATORS[a.toLowerCase()];
    if (name) return `the ${name} oracle (${addrLink(a)})`;
    if (same(a, DEPLOYER)) return `the Sigvara deployer (${addrLink(a)})`;
    return addrLink(a);
  }
  const failed = (what, e) => `<p class="pill-err">Could not read ${esc(what)}: ${esc(e?.message ?? e)}.</p>`;

  // ---- io ----
  async function getJson(url, init, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      if (res.status === 429) {
        // The explorer says, in milliseconds, when its hourly window resets.
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        throw new Error(url.startsWith(EXPLORER) && reset > 0
          ? `the explorer limits how often one address can ask, and this one has reached it. It resets in about ${Math.ceil(reset / 60000)} min`
          : "too many requests from this address. Try again later");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "timed out" : e.message);
    } finally {
      clearTimeout(t);
    }
  }

  // Many JSON-RPC requests in one, matched on id. `calls` are [method, params] pairs.
  async function rpcMany(calls) {
    if (!calls.length) return [];
    const arr = await getJson(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i, method, params }))),
    });
    if (!Array.isArray(arr)) throw new Error(arr?.error?.message ?? "batch call failed");
    const byId = new Map(arr.map((r) => [r.id, r]));
    return calls.map((_, i) => {
      const r = byId.get(i);
      if (!r || r.error || r.result === undefined) throw new Error(r?.error?.message ?? "missing result in batch");
      return r.result;
    });
  }
  // eth_calls, in chunks, so one page never sends the public RPC an unbounded batch.
  async function ethCalls(calls, chunk = 40) {
    const out = [];
    for (let i = 0; i < calls.length; i += chunk) {
      const part = await rpcMany(calls.slice(i, i + chunk).map((c) => ["eth_call", [{ to: c.to, data: c.data }, "latest"]]));
      for (const r of part) {
        if (typeof r !== "string") throw new Error("a contract read came back empty");
        out.push(r);
      }
    }
    return out;
  }

  // One contract's logs for one event set, from the explorer, oldest first. A full page is
  // continued from its last block, because the explorer has no cursor; rows already seen are
  // dropped. Kept in the tab for ten minutes, because the explorer allows ten requests an hour.
  async function contractLogs(address, names) {
    const wanted = EVENTS.filter((e) => names.includes(e.name));
    const topics = new Map(wanted.map((e) => [e.topic, e]));
    const key = `sigvara-explorer:${address.toLowerCase()}:${names.join(",")}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key));
      if (hit && Date.now() - hit.at < LOGS_TTL_MS && Array.isArray(hit.value?.logs)) return hit.value;
    } catch (_) { /* no cache */ }
    const out = [], seen = new Set();
    let from = 0, more = false;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: String(from), toBlock: "latest" });
      // One event: let the explorer filter. Several: read the contract's logs and filter here.
      if (wanted.length === 1) q.set("topic0", wanted[0].topic);
      // A contract's whole history takes the explorer up to about 20 seconds to answer.
      const j = await getJson(`${EXPLORER_API}?${q}`, undefined, EXPLORER_TIMEOUT_MS);
      // "No logs found" comes back as status 0 with an empty result, and is an answer.
      if (!Array.isArray(j?.result)) throw new Error(typeof j?.message === "string" ? j.message : "unexpected answer");
      for (const r of j.result) {
        if (!r || typeof r !== "object" || !same(r.address, address)) continue;
        const k = `${r.transactionHash}:${r.logIndex}`;
        if (!seen.has(k)) { seen.add(k); out.push(r); }
      }
      more = j.result.length >= EXPLORER_PAGE;
      if (!more) break;
      from = parseInt(j.result[j.result.length - 1].blockNumber, 16);
    }
    const logs = [];
    for (const r of out) {
      const ev = topics.get(String(r?.topics?.[0]).toLowerCase());
      if (!ev || typeof r.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.data)) continue;
      logs.push({
        name: ev.name,
        legacy: Boolean(ev.legacy),
        topics: r.topics.map((t) => String(t).toLowerCase()),
        data: r.data,
        block: parseInt(r.blockNumber, 16),
        index: parseInt(r.logIndex, 16) || 0,
        time: parseInt(r.timeStamp, 16),
        tx: isHash(r.transactionHash) ? r.transactionHash.toLowerCase() : null,
      });
    }
    logs.sort((a, b) => a.block - b.block || a.index - b.index);
    const value = { logs, truncated: more };
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch (_) { /* no cache */ }
    return value;
  }

  // ---- evidence: the Merkle root, rebuilt the way oracle/merkle.js builds it ----
  const keccak = (bytes) => Did.keccak256(bytes);
  const hexBytes = (h) => Did.hexToBytes(strip(h).toLowerCase());
  const UINT256 = 1n << 256n;

  // How the leaf encodes the reported outcome: 0 failed, 1 succeeded, 2 not reported.
  const outcomeCode = (success) => (success === true ? 1 : success === false ? 0 : 2);

  // The leaf for one payment: keccak256(keccak256(abi.encode(bytes32 txHash, address payer,
  // uint256 amount, uint256 settledAt, uint8 outcome))). settledAt is in seconds, as the block
  // timestamp is. Throws on a field the oracle could not have committed to.
  function leafOf(e, success = e.success) {
    if (!isHash(e?.txHash)) throw new Error("a payment without a transaction hash");
    if (!isAddr(e.payer)) throw new Error("a payment without a payer address");
    const amount = BigInt(e.amount);
    const settled = BigInt(e.settledAt);
    if (amount < 0n || amount >= UINT256 || settled < 0n || settled >= UINT256) throw new Error("a payment amount or time out of range");
    const hex = pad32(e.txHash) + pad32(e.payer) + amount.toString(16).padStart(64, "0")
      + settled.toString(16).padStart(64, "0") + outcomeCode(success).toString(16).padStart(64, "0");
    return keccak(hexBytes(keccak(hexBytes(hex))));
  }

  // Sorted-pair hashing, matching OpenZeppelin's MerkleProof.
  function hashPair(a, b) {
    const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
    return keccak(hexBytes(strip(x) + strip(y)));
  }

  // Every layer, leaves first. An odd node is promoted, not duplicated.
  function layersOf(leaves) {
    if (!leaves.length) return [];
    const layers = [leaves.slice()];
    let level = leaves.slice();
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
      layers.push(next);
      level = next;
    }
    return layers;
  }
  const rootOf = (leaves) => (leaves.length ? layersOf(leaves).at(-1)[0] : ZERO32);

  // The sibling path for the leaf at `index`, in the order MerkleProof.verify expects.
  function proofOf(layers, index) {
    const proof = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (pair < layers[l].length) proof.push(layers[l][pair]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  /**
   * Which set of payments a committed root is over, if any of the readings an operator could
   * have made reproduces it.
   *
   * A proposal commits to the payments that had settled by the time it was made, and a payer can
   * sign an outcome after that (oracle/evidence-as-of.js). So a root is tried against every
   * payment, against those settled by a cut-off, and against both with each payer-signed outcome
   * set back to unreported. With `at` (the proposal's time, in seconds) only that cut-off is
   * tried; without it, the cut-offs are each settlement time, newest first, up to `maxCuts`.
   *
   * Returns { events, leaves, cut, unset } for the reading that matched, or null.
   */
  function matchRoot(events, committed, { at = null, maxCuts = 64 } = {}) {
    if (!isHash(committed)) return null;
    const want = committed.toLowerCase();
    const asServed = events.map((e) => leafOf(e));
    const signed = events.map((e) => e.outcomeSource === "payer_signed");
    const unsetLeaves = events.map((e, i) => (signed[i] ? leafOf(e, null) : asServed[i]));
    const cuts = at !== null
      ? [Number(at)]
      : [Infinity, ...[...new Set(events.map((e) => Number(e.settledAt)))].sort((a, b) => b - a).slice(0, maxCuts)];
    // Each cut-off keeps every payment settled by then, so the settlement times cover every set a
    // proposal made between two of them could have committed to.
    for (const cut of cuts) {
      const idx = events.map((e, i) => (Number(e.settledAt) <= cut ? i : -1)).filter((i) => i >= 0);
      const tries = [[asServed, false]];
      if (idx.some((i) => signed[i])) tries.push([unsetLeaves, true]);
      for (const [leaves, unset] of tries) {
        const picked = idx.map((i) => leaves[i]);
        if (rootOf(picked).toLowerCase() === want) {
          return { events: idx.map((i) => events[i]), leaves: picked, cut, unset };
        }
      }
    }
    return null;
  }

  // The calldata for SigvaraReputation.verifyEvidence(bytes32 didHash, bytes32 leaf, bytes32[] proof).
  function verifyEvidenceCall(didHash, leaf, proof) {
    return SEL.verifyEvidence + pad32(didHash) + pad32(leaf) + pad32("60")
      + proof.length.toString(16).padStart(64, "0") + proof.map(pad32).join("");
  }

  const api = {
    CHAIN_ID, RPC, EXPLORER, PRIMARY, CHECKER, SOURCE,
    IDENTITY, REPUTATION, STAKING, ORACLE_BOND, SVR, DEPLOYER, OPERATORS,
    SEL, EVENTS, BOND_EVENTS, STATUS, BOND_STATUS, ZERO32, READING_HISTORY,
    esc, strip, pad32, word, wordAddr, isAddr, isHash, same, short, topicAddr,
    fmtWhen, fmtSvr, txLink, addrLink, rootCode, commitLink, whoIs, failed,
    getJson, rpcMany, ethCalls, contractLogs,
    outcomeCode, leafOf, hashPair, layersOf, rootOf, proofOf, matchRoot, verifyEvidenceCall,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SigvaraExplorer = api;
})(typeof window !== "undefined" ? window : globalThis);
