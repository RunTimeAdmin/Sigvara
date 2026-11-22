'use strict';

// The /app page (site/assets/app.js) moves bonds through the visitor's wallet. It exports nothing, so
// these tests run it in a vm context with a stub DOM, a stub RPC whose answers the test can hold back,
// and a stub EIP-1193 wallet that records every request.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Did = require('../site/assets/did.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'app.js'), 'utf8');
const ARC = '0x4cef52';
const STAKING = '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B';
const OPERATOR = '0x00000000000000000000000000000000000000c1';
const [A, B, C] = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2', '0x00000000000000000000000000000000000000c3'];
const didOf = (addr) => Did.computeDidHash(addr, 5042002).toLowerCase();
const SVR_UNIT = 10n ** 18n;
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const idle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

// Selectors as app.js has them (scripts/check-docs.mjs holds them to src/).
const SEL = {
  identities: '0x81638e9b', getTotalScore: '0x2522be94', getPendingScore: '0x56cf76e7', getReputation: '0xd14519d2',
  getStake: '0xe765c122', minimumStake: '0xec5ffac2', getPendingWithdrawal: '0xd0fe00db', getSlashProposal: '0xc984f6f8',
  unbondingPeriod: '0x6cf6d675', slashSuspended: '0x72657d89', DISPUTE_RESOLUTION_PERIOD: '0xf0d1dc00', inflowsPausedUntil: '0xeed6e97a',
  symbol: '0x95d89b41', decimals: '0x313ce567', balanceOf: '0x70a08231', claimable: '0x402914f5', allowance: '0xdd62ed3e',
  registrationDigest: '0x9aad085f',
};

function element(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', disabled: false, href: '', placeholder: '', onclick: null,
    style: {}, dataset: {}, childNodes: [], scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {} },
    insertAdjacentHTML(_, html) { this.innerHTML += html; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeAttribute() {}, click() {},
  };
}

/**
 * The page, loaded. `agents` maps an address to its chain state; `hold(did)` may return a promise the
 * RPC waits on before it answers a lookup of that agent, or rejects with. `receipt(hash, n)` is what the
 * RPC answers to the page's nth receipt read (it may return a promise, or throw); by default every
 * transaction is confirmed. `rpc` replaces the stub RPC's fetch. Every timer the page sets fires at once,
 * and `waits` records the delay it asked for. `downloads` holds each link the page clicked to save a file.
 */
function load({ agents = {}, hold = () => null, receipt = () => ({ status: '0x1', blockNumber: '0x10' }), rpc = null, balances = {}, holdCall = () => null, fail = () => null } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
  const byDid = new Map(Object.entries(agents).map(([addr, s]) => [didOf(addr), { addr, ...s }]));
  const answer = ({ to, data }) => {
    const sel = data.slice(0, 10);
    const did = `0x${data.slice(10, 74)}`;
    const a = byDid.get(did);
    switch (sel) {
      case SEL.identities: return a ? `0x${addrWord(a.operator ?? OPERATOR)}${addrWord(a.addr)}${w(0)}${w(a.status ?? 0)}${w(1_700_000_000)}` : `0x${w(0).repeat(5)}`;
      case SEL.getStake: return `0x${w(a?.stake ?? 0n)}`;
      case SEL.minimumStake: return `0x${w(1000n * SVR_UNIT)}`;
      case SEL.slashSuspended: return `0x${w(a?.slashSuspended ? 1 : 0)}`;
      case SEL.unbondingPeriod: return `0x${w(21 * 86400)}`;
      case SEL.DISPUTE_RESOLUTION_PERIOD: return `0x${w(14 * 86400)}`;
      case SEL.getTotalScore: return `0x${w(40)}`;
      case SEL.getPendingScore: return `0x${w(0).repeat(12)}`;
      case SEL.getReputation: return `0x${w(0).repeat(8)}`;
      case SEL.getPendingWithdrawal: return `0x${w(0).repeat(2)}`;
      case SEL.getSlashProposal: return `0x${w(0).repeat(9)}`;
      case SEL.inflowsPausedUntil: return `0x${w(0)}`;
      case SEL.symbol: return `0x${w(32)}${w(3)}${Buffer.from('SVR').toString('hex').padEnd(64, '0')}`;
      case SEL.decimals: return `0x${w(18)}`;
      // A balance by the account it is asked for (the last 40 hex digits of the calldata).
      case SEL.balanceOf: return `0x${w(balances[`0x${data.slice(-40)}`] ?? 0n)}`;
      case SEL.claimable: case SEL.allowance: return `0x${w(0)}`;
      case SEL.registrationDigest: return `0x${w(0xd16e57)}`;
      default: throw new Error(`no stub for ${sel} on ${to}`);
    }
  };
  const batches = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    // `fail(selector)` may name an error the node answers that call with.
    const one = (r) => {
      const message = fail(r.params[0].data.slice(0, 10));
      return message ? { jsonrpc: '2.0', id: r.id, error: { code: -32603, message } } : { jsonrpc: '2.0', id: r.id, result: answer(r.params[0]) };
    };
    if (Array.isArray(body)) {
      batches.push(body);
      const gate = hold(`0x${body[0].params[0].data.slice(10, 74)}`);
      if (gate) await gate;
      return { json: async () => body.map(one) };
    }
    if (body.method === 'eth_getTransactionReceipt') {
      const result = await receipt(body.params[0], ++receiptReads);
      return { json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
    }
    const gate = holdCall(body.params?.[0]?.data ?? '');
    if (gate) await gate;
    return { json: async () => one(body) };
  };
  let receiptReads = 0;
  const downloads = [];
  const waits = [];
  const ctx = vm.createContext({
    document: {
      getElementById: $, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { const el = element(null); el.click = () => { if (el.download) downloads.push(el); }; return el; },
    },
    window: { addEventListener() {}, dispatchEvent() {} },
    Event: class { constructor(type) { this.type = type; } },
    SigvaraDid: Did,
    fetch: rpc ?? fetch,
    setTimeout: (fn, ms) => { waits.push(ms); return setImmediate(fn); },
    clearTimeout: clearImmediate,
    AbortController,
    console,
    // What registering needs from the browser: Ed25519 keys, a file to save, and base64.
    crypto: globalThis.crypto, Blob, URL, btoa,
  });
  vm.runInContext(SOURCE, ctx, { filename: 'app.js' });
  return { ctx, $, batches, waits, downloads, get: (name) => vm.runInContext(name, ctx) };
}

// A node that accepts the connection and never answers: the request ends only if the page aborts it.
const neverAnswers = (_url, init) => new Promise((_, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
});

/**
 * An EIP-1193 wallet. `chain` and `account` can be changed under the page, as a user switching networks
 * or accounts does. `connect` may return a promise eth_requestAccounts waits on; `sign(n)` answers the
 * nth personal_sign, and throws to refuse it.
 */
function wallet({ chain = ARC, account = OPERATOR, switchError = null, addSwitches = true, connect = () => null, sign = () => `0x${'11'.repeat(65)}`, send = () => null } = {}) {
  let signs = 0;
  const p = {
    chain, account, calls: [], handlers: {}, sent: 0,
    on(event, fn) { this.handlers[event] = fn; },
    async request({ method, params }) {
      p.calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts': { const gate = connect(); if (gate) await gate; return [p.account]; }
        case 'eth_accounts': return [p.account];
        case 'personal_sign': return sign(++signs);
        case 'eth_chainId': return p.chain;
        case 'wallet_switchEthereumChain': if (switchError) throw switchError; p.chain = ARC; return null;
        case 'wallet_addEthereumChain': if (addSwitches) p.chain = ARC; return null;
        case 'eth_sendTransaction': { const gate = send(p.sent + 1); if (gate) await gate; return `0x${w(++p.sent)}`; }
        // The page reads receipts from Arc's RPC. A wallet asked anyway answers as one whose node is down.
        case 'eth_getTransactionReceipt': throw new Error('the wallet could not reach its node');
        default: throw new Error(`no stub for ${method}`);
      }
    },
  };
  return p;
}
const sends = (p) => p.calls.filter((c) => c.method === 'eth_sendTransaction');

async function connected(page, p, addr) {
  page.$('agentAddr').value = addr;
  await page.ctx.connectWith({ name: 'Test wallet', provider: p });
  await idle();
}

test('a slower, older lookup cannot repaint the card, so unbonding acts on the agent shown', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let holding = false;
  const page = load({
    agents: { [A]: { stake: 2000n * SVR_UNIT }, [B]: { stake: 2000n * SVR_UNIT }, [C]: { stake: 2000n * SVR_UNIT } },
    hold: (did) => (holding && did === didOf(A) ? held : null),
  });
  const p = wallet();
  await connected(page, p, C);
  holding = true;
  page.$('agentAddr').value = A;
  const first = page.ctx.lookup();
  page.$('agentAddr').value = B;
  await page.ctx.lookup();
  release();
  await first;
  await idle();
  const shown = page.$('didHash').textContent.toLowerCase();
  page.$('stakeAmount').value = '1';
  await page.ctx.beginUnbond();
  const [tx] = sends(p);
  assert.ok(tx, 'an unbonding was sent');
  assert.equal(tx.params[0].to, STAKING);
  assert.equal(`0x${tx.params[0].data.slice(10, 74)}`, shown, 'the unbonding names the agent the card shows');
  assert.equal(shown, didOf(B), 'the card shows the agent looked up last');
});

test('an older lookup that fails after a newer one succeeded leaves the newer card live', async () => {
  let fail;
  const held = new Promise((_, reject) => { fail = reject; });
  held.catch(() => {});
  let holding = false;
  const page = load({
    agents: { [A]: { stake: 2000n * SVR_UNIT }, [B]: { stake: 2000n * SVR_UNIT } },
    hold: (did) => (holding && did === didOf(A) ? held : null),
  });
  await connected(page, wallet(), B);
  holding = true;
  page.$('agentAddr').value = A;
  const first = page.ctx.lookup();
  page.$('agentAddr').value = B;
  await page.ctx.lookup();
  fail(new Error('rate limit'));
  await first;
  assert.equal(page.get('currentDidHash').toLowerCase(), didOf(B));
  assert.equal(page.$('unbondBtn').disabled, false);
  assert.doesNotMatch(page.$('stakeNote').textContent, /lookup failed/);
});

test('nothing is sent while the wallet is on another chain', async () => {
  const page = load({ agents: { [B]: { stake: 2000n * SVR_UNIT } } });
  const p = wallet();
  await connected(page, p, B);
  p.chain = '0x1'; // switched in the wallet, and no event has reached the page yet
  await assert.rejects(page.ctx.sendTx(STAKING, '0x'), /not Arc testnet/);
  assert.equal(sends(p).length, 0, 'eth_sendTransaction was requested on chain 0x1');
});

test('a wallet that answers with markup instead of a transaction hash gets none of it into the log', async () => {
  const page = load({ agents: { [B]: { stake: 2000n * SVR_UNIT } } });
  const p = wallet();
  await connected(page, p, B);
  const request = p.request;
  p.request = async (args) => {
    if (args.method !== 'eth_sendTransaction') return request(args);
    p.calls.push(args);
    return '0x" onmouseover="alert(1)"><img src=x>';
  };
  await assert.rejects(page.ctx.sendTx(STAKING, '0x'), /did not answer with a transaction hash/);
  assert.doesNotMatch(page.$('log').innerHTML, /<img|onmouseover/);
  assert.equal(p.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length, 0, 'the receipt was polled for a hash the wallet never gave');
});

test('a refused network switch is not answered with an add-network prompt, and leaves nothing connected', async () => {
  const page = load({ agents: { [B]: {} } });
  const refused = wallet({ chain: '0x1', switchError: Object.assign(new Error('User rejected the request.'), { code: 4001 }) });
  await connected(page, refused, B);
  assert.equal(refused.calls.filter((c) => c.method === 'wallet_addEthereumChain').length, 0, 'asked to add the chain after a refusal');
  assert.equal(page.get('account'), null);
  assert.equal(page.$('walletStatus').textContent, 'not connected');

  // A wallet that adds the chain without switching to it is not connected to Arc either.
  const stays = wallet({ chain: '0x1', switchError: Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }), addSwitches: false });
  await connected(page, stays, B);
  assert.equal(stays.calls.filter((c) => c.method === 'wallet_addEthereumChain').length, 1);
  assert.equal(page.get('account'), null);
  assert.doesNotMatch(page.$('walletStatus').innerHTML, /on 5042002/);
});

test('a chain switch in the wallet updates the pill and reads the agent again', async () => {
  const page = load({ agents: { [B]: { stake: 2000n * SVR_UNIT } } });
  const p = wallet();
  await connected(page, p, B);
  const before = page.batches.length;
  assert.equal(typeof p.handlers.chainChanged, 'function', 'the page listens for chainChanged');
  assert.equal(typeof p.handlers.accountsChanged, 'function', 'the page listens for accountsChanged');
  p.chain = '0x1';
  p.handlers.chainChanged('0x1');
  await idle();
  assert.match(page.$('walletStatus').innerHTML, /not Arc testnet/);
  assert.ok(page.batches.length > before, 'the agent was looked up again');
});

test('a double click on Bond starts one approve and one deposit', async () => {
  const page = load({ agents: { [B]: { stake: 1000n * SVR_UNIT } } });
  const p = wallet();
  await connected(page, p, B);
  page.$('stakeAmount').value = '5';
  const click = page.$('bondBtn').onclick;
  await Promise.all([click(), click()]);
  await idle();
  assert.equal(sends(p).length, 2, `${sends(p).length} transactions for one bond`);
});

test('a Suspended agent below the minimum is not called suspended by its operator alone', async () => {
  const page = load({ agents: { [B]: { status: 1, stake: 400n * SVR_UNIT } } });
  await connected(page, wallet(), B);
  const status = page.$('stakeStatus').innerHTML;
  assert.match(status, /or left suspended after a slash proposal was dropped/);
  assert.match(status, /bond it back to the minimum and reactivate it/);
  assert.match(page.$('stakeNote').innerHTML, /then reactivate it/);
});

test('a read the RPC never answers fails after 20 seconds with a message, rather than leaving the page waiting', async () => {
  const page = load({ rpc: neverAnswers });
  await idle();
  assert.equal(page.$('feeNow').textContent, 'unavailable', 'the token reads at load are still waiting');
  assert.match(page.$('log').innerHTML, /RPC read failed: the RPC did not answer within 20 seconds/);

  page.$('agentAddr').value = B;
  page.ctx.lookup(); // not awaited: a lookup with no limit never settles
  await idle();
  assert.match(page.$('log').innerHTML, /lookup failed: the RPC did not answer within 20 seconds/);
  assert.deepEqual(page.waits, [20000, 20000], 'one 20 s limit on each request');
});

// ---- confirmations, the agent a flow is for, connecting and registering -----------------------

test('a receipt read that fails is asked again, so a confirmed bond is reported as confirmed', async () => {
  // The RPC drops the first receipt read. The wallet's own node is down too, and the page must not need it.
  const page = load({
    agents: { [B]: { stake: 1000n * SVR_UNIT } },
    receipt: (_hash, n) => { if (n === 1) throw new Error('rate limit exceeded'); return { status: '0x1', blockNumber: '0x10' }; },
  });
  const p = wallet();
  await connected(page, p, B);
  page.$('stakeAmount').value = '5';
  await page.$('bondBtn').onclick();
  await idle();
  assert.equal(sends(p).length, 2, 'one approve and one deposit');
  assert.equal((page.$('log').innerHTML.match(/confirmed/g) || []).length, 2);
  assert.doesNotMatch(page.$('log').innerHTML, /pill-err/);
  assert.equal(p.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length, 0, 'the receipt was asked of the wallet');
});

test('a transaction Arc has not confirmed is reported as not confirmed yet, after the card is read again', async () => {
  const page = load({ agents: { [B]: { stake: 1000n * SVR_UNIT } }, receipt: () => null });
  const p = wallet();
  await connected(page, p, B);
  page.$('stakeAmount').value = '5';
  const before = page.batches.length;
  await page.$('bondBtn').onclick();
  await idle();
  assert.equal(sends(p).length, 1, 'nothing was sent after a transaction that was not seen');
  assert.match(page.$('log').innerHTML, /Arc has not confirmed this transaction yet/);
  assert.doesNotMatch(page.$('log').innerHTML, /timed out waiting for receipt/);
  assert.ok(page.batches.length > before, 'the agent was read again before the message');
});

test('Approve and Bond deposits for the agent it started with, whatever is looked up meanwhile', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const page = load({
    agents: { [A]: { stake: 1000n * SVR_UNIT }, [B]: { stake: 1000n * SVR_UNIT } },
    receipt: async (_hash, n) => { if (n === 1) await held; return { status: '0x1', blockNumber: '0x10' }; },
  });
  const p = wallet();
  await connected(page, p, A);
  page.$('stakeAmount').value = '5';
  const run = page.$('bondBtn').onclick();
  await idle();
  assert.equal(page.$('lookupBtn').disabled, true, 'Look up is off while the flow runs');
  // A lookup still happens, as one after a wallet event does.
  page.$('agentAddr').value = B;
  await page.ctx.lookup();
  assert.equal(page.get('currentDidHash').toLowerCase(), didOf(B), 'the card shows B');
  release();
  await run;
  await idle();
  const [, deposit] = sends(p);
  assert.ok(deposit, 'the deposit was sent');
  assert.equal(`0x${deposit.params[0].data.slice(10, 74)}`, didOf(A), 'the deposit is for the agent the flow started with');
  assert.equal(page.$('lookupBtn').disabled, false);
});

test('an account switched in the wallet during Approve and Bond stops the deposit', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const page = load({
    agents: { [B]: { stake: 1000n * SVR_UNIT } },
    receipt: async (_hash, n) => { if (n === 1) await held; return { status: '0x1', blockNumber: '0x10' }; },
  });
  const p = wallet();
  await connected(page, p, B);
  page.$('stakeAmount').value = '5';
  const run = page.$('bondBtn').onclick();
  await idle();
  p.account = C;
  release();
  await run;
  await idle();
  assert.equal(sends(p).length, 1, 'only the approve went out');
  assert.match(page.$('log').innerHTML, /not the one this action started with/);
});

test('a second Connect while the wallet is still asking is ignored, and the first one connects', async () => {
  let approve;
  const asking = new Promise((r) => { approve = r; });
  const page = load({ agents: { [B]: {} } });
  const p = wallet({ connect: () => asking });
  page.$('agentAddr').value = B;
  const c = { name: 'Test wallet', provider: p };
  const first = page.ctx.connectWith(c);
  await page.ctx.connectWith(c);
  approve();
  await first;
  await idle();
  assert.equal(p.calls.filter((x) => x.method === 'eth_requestAccounts').length, 1);
  assert.equal(page.get('account'), OPERATOR);
  assert.match(page.$('walletStatus').innerHTML, /on 5042002/);
});

test('a refused signature and a second Register keep one key file, and register its key', async () => {
  const page = load(); // the connected account itself, not registered yet
  const p = wallet({ sign: (n) => { if (n === 1) throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return `0x${'11'.repeat(65)}`; } });
  await connected(page, p, OPERATOR);
  await page.$('regBtn').onclick();
  await idle();
  assert.match(page.$('log').innerHTML, /User rejected the request/);
  await page.$('regBtn').onclick();
  await idle();
  assert.equal(page.downloads.length, 1, 'one key file for the agent');
  const [register] = sends(p);
  assert.ok(register, 'the registration was sent');
  const pubKey = register.params[0].data.slice(74, 138);
  assert.ok(page.downloads[0].download.endsWith(`-${pubKey.slice(0, 8)}.txt`), 'the key registered is the one in the file');
});

// ---- what a refresh may decide ----------------------------------------------------------

test('a balance read for the previous account does not land after the account changed', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let holding = false;
  const page = load({
    agents: { [B]: {} },
    balances: { [OPERATOR]: 7n * SVR_UNIT, [C]: 3n * SVR_UNIT },
    holdCall: (data) => (holding && data.startsWith(SEL.balanceOf) && data.endsWith(OPERATOR.slice(2)) ? held : null),
  });
  const p = wallet();
  await connected(page, p, B);
  holding = true;
  const old = page.ctx.refreshSvrBalance(); // asked for OPERATOR, answered late
  p.account = C;
  await page.ctx.walletChanged('Test wallet');
  await idle();
  assert.match(page.$('svrBal').textContent, /^3 /);
  release();
  await old;
  await idle();
  assert.match(page.$('svrBal').textContent, /^3 /, "the previous account's balance did not replace this one's");
});

test('a lookup while the faucet prompt is open does not leave the faucet off after a refusal', async () => {
  let refuse;
  const asking = new Promise((_, reject) => { refuse = reject; });
  asking.catch(() => {});
  const page = load({ agents: { [B]: { stake: 1000n * SVR_UNIT } } });
  const p = wallet({ send: () => asking });
  await connected(page, p, B);
  const run = page.$('faucetBtn').onclick();
  await idle();
  assert.equal(page.$('faucetBtn').disabled, true, 'off while it runs');
  await page.ctx.lookup(); // sets the bond card's buttons, not the faucet
  refuse(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
  await run;
  await idle();
  assert.equal(page.$('faucetBtn').disabled, false, 'the faucet is usable again');
});

test('an optional read that fails for a reason other than a revert is not read as a contract without it', async () => {
  // inflowsPausedUntil is optional because the September contracts lack it, and lacking it reverts. A
  // node error says nothing about the contract: taking it for "absent" would show Register during a pause.
  const page = load({ fail: (sel) => (sel === SEL.inflowsPausedUntil ? 'internal error' : null) });
  await connected(page, wallet(), OPERATOR);
  assert.match(page.$('log').innerHTML, /lookup failed: internal error/);
  assert.doesNotMatch(page.$('regStatus').innerHTML, /Register this agent/);

  const reverts = load({ fail: (sel) => (sel === SEL.inflowsPausedUntil ? 'execution reverted' : null) });
  await connected(reverts, wallet(), OPERATOR);
  assert.match(reverts.$('regStatus').innerHTML, /Register this agent/, 'a revert is still read as absent');
});
