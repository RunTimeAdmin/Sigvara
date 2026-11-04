/* Shared reads for the explorer pages: agents, operators and slashes.
 *
 * Reads only. No wallet, nothing signed, no external library (see app.js for why). Each page
 * says which source every fact came from:
 *   - the chain, over the public RPC: scores, stakes, bonds and the committed evidence roots.
 *   - Sigvara's event index (docs/event-index.md): which agents registered, which operators
 *     bonded and every slash. The RPC answers eth_getLogs over at most 10,000 blocks, and the
 *     index serves every log the contracts have emitted in one request, as eth_getLogs returned
 *     them. The Sigvara team runs it; each log names its transaction, so any of them can be
 *     checked against the chain. The blocks after the index's newest are read from the RPC.
 *   - the Arc explorer's log index, when the event index does not answer. The explorer allows
 *     ten requests an hour from one address, so its answers are kept in the tab for a few
 *     minutes, and its index stopped on 2 November 2026, so the blocks after that are read from
 *     the RPC as well.
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
  const INDEX = "https://index.sigvara.xyz";
  // The most /events answers one history is read in: 20 of up to 5,000 logs each.
  const INDEX_PAGES = 20;
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
  // The operator of the slash-drill agents (docs/slash-drill.md, "The adversarial drill"). It
  // holds no role; the agents it bonds exist to be slashed at, so they are marked as Sigvara's.
  const DRILL_OPERATOR = "0x11bbb7764D215c7Ab2E7c677283E226D599ce956";
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
    getSlashProposal: "0xc984f6f8",
  };
  // topic0 of each event the pages read, and the contract that emits it. scripts/check-docs.mjs
  // checks every topic against its signature, and every current one against that contract.
  // SlashExecuted carried a reporter's share until the staking upgrade of 2 November 2026; the
  // slash drill of October emitted that form.
  const EVENTS = [
    { name: "AgentRegistered", sig: "AgentRegistered(bytes32,address,address,bytes32)", topic: "0x05721be61cc3d7a6bf132adf5eaa7898a92db50c5db47b35e8ade18b06423281", contract: "identity" },
    { name: "ScoreProposed", sig: "ScoreProposed(bytes32,uint256,bytes32)", topic: "0x2ecf59b65d6c5f89b87bffff8937f2a81e253859b6b76bfd7f137c2db9b6caff", contract: "reputation" },
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
  // The RPC answers eth_getLogs over at most this many blocks, inclusive.
  const LOG_SPAN = 10000;
  // How far back the pages read the chain itself when the explorer's index is behind: about 42
  // hours of Arc blocks, at roughly two a second, which is 30 log reads.
  const TAIL_BLOCKS = 300000;
  // The block the explorer's per-contract index stopped at on 2 November 2026. Its index is not
  // relied on past it, even once its newest block moves on, because an index that resumes at the
  // head before it backfills would leave a hole a page could not see. Remove this once the
  // explorer has been seen to hold the blocks after it.
  const INDEX_STALLED_AT = 70337205;
  // Reading more than this many blocks (about an hour) from the chain is worth a note on the page.
  const LAG_NOTED = 7200;
  // An event index answering for blocks this far past the RPC's newest (about a minute) is not
  // answering for this chain as the page sees it, so its answer is not used.
  const INDEX_AHEAD = 100;
  // What a card says while it waits on the explorer.
  const READING_HISTORY = '<p class="netnote">Reading the contract\'s history from Sigvara\'s event index and the chain.</p>';

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
  // Chains whose payments the oracle can count beside this one's (ADR 0009), so that a payment
  // from one is shown in its own asset and linked to its own explorer.
  const PAYMENT_CHAINS = {
    84532: { name: "Base Sepolia", symbol: "USDC", decimals: 6, explorer: "https://sepolia.basescan.org" },
    8453: { name: "Base", symbol: "USDC", decimals: 6, explorer: "https://basescan.org" },
  };
  const paymentChainOf = (e) => (e?.chainId == null ? null : PAYMENT_CHAINS[e.chainId] ?? { name: `chain ${e.chainId}` });
  // A payment's amount in its own asset: test SVR here, or the payment chain's.
  function fmtAmount(e) {
    const c = paymentChainOf(e);
    if (!c) return fmtSvr(e?.amount);
    try {
      const v = BigInt(e.amount);
      if (!c.decimals) return `${v} base units on ${c.name}`;
      const d = 10n ** BigInt(c.decimals);
      // Every decimal that is not a trailing zero: x402 payments are often a fraction of a cent.
      const f = (v % d).toString().padStart(c.decimals, "0").replace(/0+$/, "");
      return `${f ? `${v / d}.${f}` : (v / d).toLocaleString("en-US")} ${c.symbol} on ${c.name}`;
    } catch (_) { return "?"; }
  }
  // A payment's transaction and payer, on the explorer of the chain it settled on.
  const paymentTxLink = (e) => {
    const c = paymentChainOf(e);
    if (!c) return txLink(e?.txHash);
    if (!isHash(e.txHash)) return "";
    return c.explorer ? `<a href="${c.explorer}/tx/${e.txHash}" target="_blank" rel="noopener"><code>${short(e.txHash)}</code></a>` : `<code>${short(e.txHash)}</code>`;
  };
  const paymentPayerLink = (e) => {
    const c = paymentChainOf(e);
    if (!c) return addrLink(e?.payer);
    if (!isAddr(e.payer)) return "?";
    return c.explorer ? `<a href="${c.explorer}/address/${e.payer}" target="_blank" rel="noopener"><code>${short(e.payer)}</code></a>` : `<code>${short(e.payer)}</code>`;
  };
  const rootCode = (r) => (!r ? "none" : same(r, ZERO32) ? "<code>0x0</code> (none)" : `<code title="${esc(r)}">${esc(short(r))}</code>`);
  const commitLink = (c) => (/^[0-9a-f]{40}$/.test(c || "")
    ? `<a href="${SOURCE}/commit/${c}" target="_blank" rel="noopener"><code>${c.slice(0, 7)}</code></a>` : "unknown");
  function whoIs(a) {
    if (!isAddr(a)) return "?";
    const name = OPERATORS[a.toLowerCase()];
    if (name) return `the ${name} oracle (${addrLink(a)})`;
    if (same(a, DEPLOYER)) return `the Sigvara deployer (${addrLink(a)})`;
    if (same(a, DRILL_OPERATOR)) return `the slash drill's operator (${addrLink(a)})`;
    const sim = simWallet(a);
    if (sim) return `the simulation's ${esc(sim)} (${addrLink(a)})`;
    return addrLink(a);
  }

  // ---- the testnet simulation ----
  // Every address Sigvara's testnet simulation controls (docs/simulation.md), served beside the
  // site so the pages can mark it. Absent until the simulation starts; then nothing it does can
  // pass for outside demand on these pages.
  let sim = { agents: new Map(), wallets: new Map(), loaded: false };
  async function loadSimulation() {
    if (sim.loaded) return sim;
    const agents = new Map(), wallets = new Map();
    try {
      const j = await getJson("simulation.json");
      const put = (addr, role) => { if (isAddr(addr)) wallets.set(addr.toLowerCase(), role); };
      put(j?.treasury, "treasury");
      put(j?.ringOperator, "ring operator");
      for (const o of Array.isArray(j?.operators) ? j.operators : []) put(o?.address, `operator ${String(o?.name ?? "")}`.trim());
      for (const p of Array.isArray(j?.payers) ? j.payers : []) put(p, "customer");
      for (const p of Array.isArray(j?.ringPayers) ? j.ringPayers : []) put(p, "ring customer");
      for (const a of Array.isArray(j?.agents) ? j.agents : []) {
        if (isAddr(a?.address)) agents.set(a.address.toLowerCase(), String(a.profile ?? "agent"));
      }
    } catch (_) { /* no simulation published, or not readable: nothing is marked */ }
    sim = { agents, wallets, loaded: true };
    return sim;
  }
  const simAgent = (a) => sim.agents.get(String(a).toLowerCase()) ?? null;
  const simWallet = (a) => sim.wallets.get(String(a).toLowerCase()) ?? null;
  const failed = (what, e) => `<p class="pill-err">Could not read ${esc(what)}: ${esc(e?.message ?? e)}.</p>`;

  // ---- io ----
  async function getJson(url, init, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      if (res.status === 429) {
        // The explorer says, in milliseconds, when its hourly window resets. Compared by origin,
        // since a prefix test would also match a host that merely starts with its name.
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        let fromExplorer = false;
        try { fromExplorer = new URL(url).origin === EXPLORER; } catch (_) { /* not a URL */ }
        throw new Error(fromExplorer && reset > 0
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

  // Many JSON-RPC requests, matched on id. `calls` are [method, params] pairs.
  //
  // The public RPC answers about ten calls in one batch; past that it refuses each extra call with
  // "rate limit exceeded", and it limits how fast batches arrive too. So calls go ten at a time with
  // a short gap, and a call it refused is asked again after a pause, up to four times. A log read
  // costs it more: it refuses a batch of four, so those go three at a time, a second apart.
  const RPC_BATCH = 10;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpcMany(calls, { batch = RPC_BATCH, gap = 150 } = {}) {
    const out = new Array(calls.length);
    for (let start = 0; start < calls.length; start += batch) {
      if (start) await pause(gap);
      let pending = calls.slice(start, start + batch).map((c, k) => start + k);
      for (let attempt = 0; pending.length; attempt++) {
        const arr = await getJson(RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pending.map((i) => ({ jsonrpc: "2.0", id: i, method: calls[i][0], params: calls[i][1] }))),
        });
        if (!Array.isArray(arr)) throw new Error(arr?.error?.message ?? "batch call failed");
        const byId = new Map(arr.map((r) => [r.id, r]));
        const refused = [];
        for (const i of pending) {
          const r = byId.get(i);
          if (r && !r.error && r.result !== undefined) out[i] = r.result;
          else if (/rate limit/i.test(r?.error?.message ?? "") && attempt < 4) refused.push(i);
          else throw new Error(r?.error?.message ?? "missing result in batch");
        }
        pending = refused;
        if (pending.length) await pause(500 * 2 ** attempt);
      }
    }
    return out;
  }

  // Multicall3, deployed at this address on most EVM chains, so that many reads cost one request.
  // It has no owner and nothing to upgrade, and it makes only the calls it is given, so each answer
  // is the named contract's own. On Arc its code is the same, byte for byte, as on Base and Optimism.
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
  // aggregate3((address target, bool allowFailure, bytes callData)[]). Not in SEL, because
  // scripts/check-docs.mjs checks SEL against src/ and this contract is not ours.
  const AGGREGATE3 = "0x82ad56cb";
  // The most reads in one call. The RPC gives an eth_call 30,000,000 gas. Measured on 4 November
  // 2026, it takes 2,000 score reads, or 1,000 verifyEvidence calls with proofs of 13 hashes. It
  // refuses 5,000 of the first and 2,000 of the second.
  const MULTICALL_READS = 500;

  // The calldata for aggregate3, with every read allowed to fail.
  function aggregate3Call(calls) {
    const offsets = [], items = [];
    let at = calls.length * 32;
    for (const c of calls) {
      const data = strip(c.data);
      const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
      offsets.push(pad32(at.toString(16)));
      items.push(pad32(c.to) + pad32("1") + pad32("60") + pad32((data.length / 2).toString(16)) + padded);
      at += 128 + padded.length / 2;
    }
    return AGGREGATE3 + pad32("20") + pad32(calls.length.toString(16)) + offsets.join("") + items.join("");
  }

  // Its answers in order, each as hex, or null for a read that reverted. An answer that does not
  // parse throws: it came over the network, and its own offsets say where to read next.
  function aggregate3Answers(answer, count) {
    const hex = strip(String(answer));
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("the multicall answer is not hex");
    // The number in the word at a byte offset. A word past the end, or one too large to be an
    // offset or a length, means this is not an answer.
    const num = (at) => {
      const w = hex.slice(at * 2, at * 2 + 64);
      const n = w.length === 64 ? Number(BigInt("0x" + w)) : NaN;
      if (!Number.isSafeInteger(n)) throw new Error("the multicall answer does not parse");
      return n;
    };
    const array = num(0);
    if (num(array) !== count) throw new Error("the multicall answer has the wrong number of results");
    const first = array + 32;
    const out = [];
    for (let i = 0; i < count; i++) {
      const item = first + num(first + i * 32);
      const data = item + num(item + 32);
      const from = data + 32;
      const to = from + num(data);
      if (to * 2 > hex.length) throw new Error("the multicall answer does not parse");
      out.push(num(item) === 1 ? "0x" + hex.slice(from * 2, to * 2) : null);
    }
    return out;
  }

  async function multicall(calls) {
    const sets = [];
    for (let i = 0; i < calls.length; i += MULTICALL_READS) sets.push(calls.slice(i, i + MULTICALL_READS));
    const raw = await rpcMany(sets.map((set) => ["eth_call", [{ to: MULTICALL3, data: aggregate3Call(set) }, "latest"]]), { batch: 1 });
    return raw.flatMap((r, i) => aggregate3Answers(r, sets[i].length));
  }

  // eth_calls: the result of each, as hex. Two or more go through Multicall3. If that fails, or a
  // read in it reverted, the whole set is asked directly, so the caller gets the RPC's own answer
  // or its own error.
  async function ethCalls(calls) {
    const bundled = calls.length > 1 ? await multicall(calls).catch(() => null) : null;
    const out = bundled && !bundled.includes(null)
      ? bundled
      : await rpcMany(calls.map((c) => ["eth_call", [{ to: c.to, data: c.data }, "latest"]]));
    for (const r of out) if (typeof r !== "string") throw new Error("a contract read came back empty");
    return out;
  }

  async function blockNumber() {
    const [h] = await rpcMany([["eth_blockNumber", []]]);
    const n = parseInt(h, 16);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("no block number");
    return n;
  }

  // An answer kept in the tab for ten minutes, because the explorer allows ten requests an hour
  // and the RPC's log reads are slow. A read that fails is not kept. Storage can be missing or
  // refuse a write; then every call asks again.
  async function cached(key, read) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(key));
      if (hit && Date.now() - hit.at < LOGS_TTL_MS && hit.value !== undefined) return hit.value;
    } catch (_) { /* no cache */ }
    const value = await read();
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch (_) { /* no cache */ }
    return value;
  }

  // The newest block the explorer has indexed, as { block, time }, or null when it does not say.
  // Its block list is no guide: on 2 November 2026 that kept up while the per-contract index
  // stopped. So this is the reputation contract's newest indexed log, which the oracle writes
  // every epoch it has something to score.
  async function indexHead() {
    try {
      return await cached("sigvara-explorer:index-head", async () => {
        const j = await getJson(`${EXPLORER}/api/v2/addresses/${REPUTATION}/logs`);
        const block = Number(j?.items?.[0]?.block_number);
        const time = Math.floor(Date.parse(j?.items?.[0]?.block_timestamp) / 1000);
        return Number.isSafeInteger(block) && block > 0 ? { block, time: time > 0 ? time : null } : null;
      });
    } catch (_) { return null; }
  }

  // Log reads go one stream at a time across the page: two at once are more than the RPC allows.
  let logQueue = Promise.resolve();
  const queued = (read) => {
    const run = logQueue.then(read, read);
    logQueue = run.catch(() => {});
    return run;
  };

  // Logs from the chain itself over blocks [from, to], read in spans the RPC accepts, as rows
  // shaped like the explorer's (its hex timeStamp included unless `times` is false), so both go
  // through the same parsing. `topics` is an eth_getLogs topic filter, or null for none.
  async function chainLogs(addresses, topics, from, to, { times = true } = {}) {
    const hex = (n) => "0x" + n.toString(16);
    const spans = [];
    for (let end = to; end >= from; end -= LOG_SPAN) spans.push([Math.max(from, end - LOG_SPAN + 1), end]);
    const filter = (a, b) => ({ address: addresses, ...(topics ? { topics } : {}), fromBlock: hex(a), toBlock: hex(b) });
    const got = await queued(() => rpcMany(spans.map(([a, b]) => ["eth_getLogs", [filter(a, b)]]), { batch: 3, gap: 1000 }));
    if (!got.every(Array.isArray)) throw new Error("a log read came back malformed");
    const rows = got.flat().filter((r) => r && typeof r === "object" && !r.removed);
    // Arc's RPC gives each log its block's time; addTimes covers one that does not.
    for (const r of rows) if (typeof r.blockTimestamp === "string") r.timeStamp = r.blockTimestamp;
    if (times) await addTimes(rows);
    return rows;
  }
  // The block time of each row that does not carry one yet.
  async function addTimes(all) {
    const rows = all.filter((r) => r.timeStamp === undefined);
    const blocks = [...new Set(rows.map((r) => r.blockNumber))].filter((b) => typeof b === "string");
    const got = await rpcMany(blocks.map((b) => ["eth_getBlockByNumber", [b, false]]));
    const at = new Map(blocks.map((b, i) => [b, got[i]?.timestamp]));
    for (const r of rows) r.timeStamp = at.get(r.blockNumber);
  }

  // Where to read the chain itself: from just past the last block the explorer is relied on for
  // (its newest, but no later than INDEX_STALLED_AT, which also stands in when it does not say),
  // or TAIL_BLOCKS back if that is nearer, to the newest block. `missed` is the span between.
  async function tailRange() {
    const [head, latest] = await Promise.all([indexHead(), blockNumber()]);
    const floor = Math.max(0, latest - TAIL_BLOCKS + 1);
    const trusted = Math.min(head?.block ?? INDEX_STALLED_AT, INDEX_STALLED_AT);
    const from = Math.max(trusted + 1, floor);
    return { from, to: latest, indexHead: head, missed: from > trusted + 1 ? [trusted + 1, from - 1] : null };
  }

  // The identity, staking and bond contracts' logs in the blocks the explorer is not relied on
  // for. One read serves every page, and it is kept in the tab like the explorer's answers. It reads
  // every log the three emit and contractLogs picks out its events, because the RPC calls a
  // filter on the fifteen topics the pages read "requested range too large" over any span.
  function chainTail() {
    return cached("sigvara-explorer:tail", async () => {
      const range = await tailRange();
      const rows = range.from <= range.to ? await chainLogs([IDENTITY, STAKING, ORACLE_BOND], null, range.from, range.to) : [];
      return { ...range, rows };
    });
  }

  // One contract's logs for one event set, from the explorer, as it answers them. A full page is
  // continued from its last block, because the explorer has no cursor. Kept in the tab apart
  // from the chain's tail, so a page is never older than the older of the two.
  function explorerLogs(address, wanted) {
    const key = `sigvara-explorer-logs:${address.toLowerCase()}:${wanted.map((e) => e.topic).join(",")}`;
    return cached(key, () => explorerPages(address, wanted));
  }
  async function explorerPages(address, wanted) {
    const rows = [];
    let from = 0, more = false;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: String(from), toBlock: "latest" });
      // One event: let the explorer filter. Several: read the contract's logs and filter here.
      if (wanted.length === 1) q.set("topic0", wanted[0].topic);
      // A contract's whole history takes the explorer up to about 20 seconds to answer.
      const j = await getJson(`${EXPLORER_API}?${q}`, undefined, EXPLORER_TIMEOUT_MS);
      // "No logs found" comes back as status 0 with an empty result, and is an answer.
      if (!Array.isArray(j?.result)) throw new Error(typeof j?.message === "string" ? j.message : "unexpected answer");
      rows.push(...j.result);
      more = j.result.length >= EXPLORER_PAGE;
      if (!more) break;
      from = parseInt(j.result[j.result.length - 1].blockNumber, 16);
    }
    return { rows, more };
  }

  /**
   * The logs of `addresses` from the event index, then the blocks after its newest read from the
   * chain, as rows shaped like eth_getLogs'. `topic0` (a list of event topics) and `topic1` (one
   * value) narrow both reads alike; `fromBlock` leaves out older blocks. Throws when the index
   * does not answer, so a page can fall back to the explorer; a chain read that fails is reported
   * in `tail.error` instead. `tail` says how the chain filled in, for historyNote.
   */
  async function indexLogs(addresses, { topic0 = null, topic1 = null, fromBlock = null } = {}) {
    const q = new URLSearchParams({ address: addresses.join(",") });
    if (topic0) q.set("topic0", topic0.join(","));
    if (topic1) q.set("topic1", topic1);
    if (fromBlock !== null) q.set("fromBlock", String(fromBlock));
    const headRead = blockNumber().then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));
    // A long history comes a page at a time: each answer's `next` asks for the rest, and the last
    // answer's toBlock is where the chain takes over.
    const indexed = [];
    let j = null;
    let page = 0;
    for (let after = null; ;) {
      if (page === INDEX_PAGES) throw new Error(`the event index has more than ${INDEX_PAGES} pages for this history`);
      if (after) q.set("after", after);
      j = await getJson(`${INDEX}/events?${q}`);
      page++;
      if (j?.chainId !== CHAIN_ID || !Array.isArray(j?.logs) || !Number.isSafeInteger(Number(j?.toBlock))) {
        throw new Error("the event index gave an answer for something else");
      }
      indexed.push(...j.logs);
      if (typeof j.next !== "string" || j.next === "") break;
      if (j.next === after) throw new Error("the event index gave the same page twice");
      after = j.next;
    }
    // Read the head again after more than one page: the index moved on while they were read, and
    // the last page's toBlock is compared with the chain's newest block below.
    const head = page > 1 ? await blockNumber().then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })) : await headRead;
    const toBlock = Number(j.toBlock);
    const indexHead = { block: toBlock, time: Number(j.toBlockTime) > 0 ? Number(j.toBlockTime) : null };
    // The index answered; a chain that does not is the chain's problem, said as such.
    if (head.status === "rejected") {
      return { rows: indexed, tail: { source: "index", from: toBlock + 1, to: toBlock, missed: null, indexHead, error: String(head.reason?.message ?? head.reason) } };
    }
    const latest = head.value;
    if (toBlock > latest + INDEX_AHEAD) throw new Error(`the event index claims block ${toBlock}, past the chain's newest, ${latest}`);
    // From just past the index, or from where the caller starts if that is later, but no
    // further back than TAIL_BLOCKS. `missed` is what that leaves out.
    const want = Math.max(toBlock + 1, fromBlock ?? 0);
    const from = Math.max(want, latest - TAIL_BLOCKS + 1);
    const topics = topic0 || topic1 ? [topic0, ...(topic1 ? [topic1] : [])] : null;
    const tail = { source: "index", from, to: latest, missed: from > want ? [want, from - 1] : null, indexHead };
    let rows = [];
    try {
      if (from <= latest) rows = await chainLogs(addresses, topics, from, latest);
    } catch (e) {
      tail.error = String(e?.message ?? e);
    }
    return { rows: [...indexed, ...rows], tail };
  }

  // One contract's logs for one event set, oldest first: from the event index and the chain, or,
  // when the index does not answer, from the Arc explorer and the chain. A row two sources hold
  // is kept once. `tail` says where the history came from, for historyNote.
  async function contractLogs(address, names) {
    const wanted = EVENTS.filter((e) => names.includes(e.name));
    const topics = new Map(wanted.map((e) => [e.topic, e]));
    let rows, more = false, how;
    try {
      ({ rows, tail: how } = await indexLogs([address], { topic0: wanted.map((e) => e.topic) }));
    } catch (indexError) {
      const [indexed, tail] = await Promise.all([
        explorerLogs(address, wanted),
        chainTail().catch((e) => ({ error: String(e?.message ?? e), rows: [] })),
      ]);
      rows = [...indexed.rows, ...tail.rows];
      more = indexed.more;
      const { rows: _, ...rest } = tail;
      how = { ...rest, indexError: String(indexError?.message ?? indexError) };
    }
    const logs = [], seen = new Set();
    for (const r of rows) {
      if (!r || typeof r !== "object" || !same(r.address, address)) continue;
      const ev = topics.get(String(r?.topics?.[0]).toLowerCase());
      if (!ev || typeof r.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.data)) continue;
      const tx = isHash(r.transactionHash) ? r.transactionHash.toLowerCase() : null;
      const index = parseInt(r.logIndex, 16) || 0;
      if (seen.has(`${tx}:${index}`)) continue;
      seen.add(`${tx}:${index}`);
      logs.push({
        name: ev.name,
        legacy: Boolean(ev.legacy),
        topics: r.topics.map((t) => String(t).toLowerCase()),
        data: r.data,
        block: parseInt(r.blockNumber, 16),
        index,
        time: parseInt(r.timeStamp ?? r.blockTimestamp, 16),
        tx,
      });
    }
    logs.sort((a, b) => a.block - b.block || a.index - b.index);
    return { logs, truncated: more, tail: how };
  }

  // What a page says under a history the chain had to fill in, or "". Quiet when the event index
  // answered and was current; otherwise it says what was read from where, and what may be missing.
  function historyNote(v) {
    const t = v?.tail;
    const n = (x) => Number(x).toLocaleString("en-US");
    if (!t) return "";
    if (t.source === "index") {
      const at = t.indexHead.time ? ` (${esc(fmtWhen(t.indexHead.time))})` : "";
      if (t.error) return `<p class="pill-warn">Sigvara's event index answered up to block ${n(t.indexHead.block)}${at}, but the blocks after it could not be read from the chain (${esc(t.error)}), so the newest entries may be missing.</p>`;
      if (t.missed) return `<p class="pill-warn">Sigvara's event index answered only up to block ${n(t.indexHead.block)}${at}, and blocks ${n(t.missed[0])} to ${n(t.missed[1])} are further back than the ${n(TAIL_BLOCKS)} this page reads from the chain itself, so entries from them may be missing.</p>`;
      if (t.to - t.from + 1 < LAG_NOTED) return "";
      return `<p class="netnote">Sigvara's event index is behind the chain, at block ${n(t.indexHead.block)}${at}, so blocks ${n(t.from)} to ${n(t.to)} were read from the chain itself.</p>`;
    }
    const fallback = t.indexError ? `<p class="netnote">Sigvara's event index did not answer (${esc(t.indexError)}), so this history comes from the Arc explorer.</p>` : "";
    return fallback + explorerNote(t, n);
  }
  function explorerNote(t, n) {
    if (t.error) return `<p class="pill-warn">The newest blocks, which the Arc explorer may not have indexed yet, could not be read from the chain (${esc(t.error)}), so the newest entries may be missing.</p>`;
    const head = t.indexHead
      ? ` The explorer's newest log for the reputation contract is in block ${n(t.indexHead.block)}${t.indexHead.time ? ` (${esc(fmtWhen(t.indexHead.time))})` : ""}.` : "";
    if (t.missed) {
      return `<p class="pill-warn">Blocks ${n(t.missed[0])} to ${n(t.missed[1])} were not read from the chain, and the Arc explorer's index is not relied on for them, so entries from them may be missing. This page reads only the newest ${n(TAIL_BLOCKS)} blocks from the chain itself.${head}</p>`;
    }
    if (t.to - t.from + 1 < LAG_NOTED) return "";
    return `<p class="netnote">Blocks ${n(t.from)} to ${n(t.to)} were read from the chain itself, because the Arc explorer's index is not relied on past block ${n(t.from - 1)}.${head}</p>`;
  }

  // ---- evidence: the Merkle root, rebuilt the way oracle/merkle.js builds it ----
  const keccak = (bytes) => Did.keccak256(bytes);
  const hexBytes = (h) => Did.hexToBytes(strip(h).toLowerCase());
  const UINT256 = 1n << 256n;

  // How the leaf encodes the reported outcome: 0 failed, 1 succeeded, 2 not reported.
  const outcomeCode = (success) => (success === true ? 1 : success === false ? 0 : 2);

  // The leaf for one payment: keccak256(keccak256(abi.encode(bytes32 txHash, address payer,
  // uint256 amount, uint256 settledAt, uint8 outcome))). settledAt is in seconds, as the block
  // timestamp is. A payment that settled on a payment chain (ADR 0009) has its uint256 chainId in
  // front. Throws on a field the oracle could not have committed to.
  function leafOf(e, success = e.success) {
    if (!isHash(e?.txHash)) throw new Error("a payment without a transaction hash");
    if (!isAddr(e.payer)) throw new Error("a payment without a payer address");
    const amount = BigInt(e.amount);
    const settled = BigInt(e.settledAt);
    if (amount < 0n || amount >= UINT256 || settled < 0n || settled >= UINT256) throw new Error("a payment amount or time out of range");
    let chain = "";
    if (e.chainId != null) {
      if (!Number.isSafeInteger(e.chainId) || e.chainId <= 0) throw new Error("a payment with a chain id that is not one");
      chain = BigInt(e.chainId).toString(16).padStart(64, "0");
    }
    const hex = chain + pad32(e.txHash) + pad32(e.payer) + amount.toString(16).padStart(64, "0")
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
   * `delays` (chain id to seconds, as /evidence serves them) says how much later a payment chain's
   * payment enters a score than its settlement: it counts for a cut-off once settledAt plus its
   * delay has passed. `evidenceCut` ({ quantumSeconds, windowSeconds }, also from /evidence, present
   * when the oracle reads payment chains) says a proposal's evidence was cut at a whole quantum at
   * most the window before `at`, so with `at` those cut-offs are tried too.
   *
   * Returns { events, leaves, cut, unset } for the reading that matched, or null.
   */
  function matchRoot(events, committed, { at = null, maxCuts = 64, delays = {}, evidenceCut = null } = {}) {
    if (!isHash(committed)) return null;
    const want = committed.toLowerCase();
    const asServed = events.map((e) => leafOf(e));
    const signed = events.map((e) => e.outcomeSource === "payer_signed");
    const unsetLeaves = events.map((e, i) => (signed[i] ? leafOf(e, null) : asServed[i]));
    const counts = events.map((e) => Number(e.settledAt) + (e.chainId != null ? Number(delays[e.chainId] ?? 0) : 0));
    const q = Number(evidenceCut?.quantumSeconds) || 0;
    const w = Number(evidenceCut?.windowSeconds) || 0;
    const quantized = [];
    if (at !== null && q > 0 && w > 0) {
      for (let t = Math.floor(Number(at) / q) * q; t > Number(at) - w; t -= q) quantized.push(t);
    }
    const cuts = at !== null
      ? [Number(at), ...quantized.filter((t) => t < Number(at))]
      : [Infinity, ...[...new Set(counts)].sort((a, b) => b - a).slice(0, maxCuts)];
    // Each cut-off keeps every payment that counted by then, so those times cover every set a
    // proposal made between two of them could have committed to.
    for (const cut of cuts) {
      const idx = events.map((e, i) => (counts[i] <= cut ? i : -1)).filter((i) => i >= 0);
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
    IDENTITY, REPUTATION, STAKING, ORACLE_BOND, SVR, DEPLOYER, DRILL_OPERATOR, OPERATORS,
    SEL, EVENTS, BOND_EVENTS, STATUS, BOND_STATUS, ZERO32, READING_HISTORY, TAIL_BLOCKS,
    esc, strip, pad32, word, wordAddr, isAddr, isHash, same, short, topicAddr,
    fmtWhen, fmtSvr, txLink, addrLink, rootCode, commitLink, whoIs, failed,
    PAYMENT_CHAINS, fmtAmount, paymentTxLink, paymentPayerLink,
    loadSimulation, simAgent, simWallet,
    getJson, rpcMany, ethCalls, MULTICALL3, aggregate3Call, aggregate3Answers, blockNumber, cached, chainLogs, addTimes, tailRange, indexLogs, contractLogs, historyNote,
    outcomeCode, leafOf, hashPair, layersOf, rootOf, proofOf, matchRoot, verifyEvidenceCall,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SigvaraExplorer = api;
})(typeof window !== "undefined" ? window : globalThis);
