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
 * RPC waits on before it answers a lookup of that agent, or rejects with.
 */
function load({ agents = {}, hold = () => null } = {}) {
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
      case SEL.balanceOf: case SEL.claimable: case SEL.allowance: return `0x${w(0)}`;
      default: throw new Error(`no stub for ${sel} on ${to}`);
    }
  };
  const batches = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r.params[0]) });
    if (Array.isArray(body)) {
      batches.push(body);
      const gate = hold(`0x${body[0].params[0].data.slice(10, 74)}`);
      if (gate) await gate;
      return { json: async () => body.map(one) };
    }
    return { json: async () => one(body) };
  };
  const ctx = vm.createContext({
    document: { getElementById: $, createElement: () => element(null), querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {}, dispatchEvent() {} },
    Event: class { constructor(type) { this.type = type; } },
    SigvaraDid: Did,
    fetch,
    setTimeout: (fn) => setImmediate(fn),
    console,
  });
  vm.runInContext(SOURCE, ctx, { filename: 'app.js' });
  return { ctx, $, batches, get: (name) => vm.runInContext(name, ctx) };
}

/** An EIP-1193 wallet. `chain` can be changed under the page, as a user switching networks does. */
function wallet({ chain = ARC, account = OPERATOR, switchError = null, addSwitches = true } = {}) {
  const p = {
    chain, calls: [], handlers: {}, sent: 0,
    on(event, fn) { this.handlers[event] = fn; },
    async request({ method, params }) {
      p.calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [account];
        case 'eth_chainId': return p.chain;
        case 'wallet_switchEthereumChain': if (switchError) throw switchError; p.chain = ARC; return null;
        case 'wallet_addEthereumChain': if (addSwitches) p.chain = ARC; return null;
        case 'eth_sendTransaction': return `0x${w(++p.sent)}`;
        case 'eth_getTransactionReceipt': return { status: '0x1', blockNumber: '0x10' };
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
