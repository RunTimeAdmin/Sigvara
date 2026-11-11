// The second batch's runner. See docs/simulation.md, "Batch 2".
//
//   node sim/src/batch2/run.mjs plan [hours]   the actions of the next hours, without a chain or keys
//   node sim/src/batch2/run.mjs registry       every address this batch controls, as public JSON
//   node sim/src/batch2/run.mjs tick           carry out the current hour, then exit
//   node sim/src/batch2/run.mjs loop           tick every few minutes until the batch ends
//
// Environment, as the first batch's (SIM_MNEMONIC_FILE, SIM_STATE_FILE, SIM_SEED, SIM_RPC_URL,
// SIM_ORACLE_URL, SIM_PAUSE_FILE), plus SIM_BASE_RPC_URL for Base Sepolia, SIM_X402_FACILITATOR (the
// public testnet facilitator by default; `self` submits from the treasury, which then needs Base
// Sepolia ETH), and SIM_COUNTERAUDIT_URL with SIM_COUNTERAUDIT_KEY_FILE, a file holding a CounterAudit
// API key. Without the key every outcome goes straight to the oracle, and the state says so.
//
// It acts only on its cast: every payment goes to one of its agents, and the reviewers it borrows
// from the first batch pay and review only this batch's reviewed agents. It stops after DAYS days.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { ethers } from 'ethers';
import { registerAgent, depositStake, signPaymentOutcome, computeDidHash, OUTCOME_DELIVERED } from '@sigvara/protocol-sdk';
import { buildCast, REVIEW } from './cast.mjs';
import { planHour, HOURS, RETRIED } from './plan.mjs';
import { rng } from '../rng.mjs';
import { loadMnemonic, walletAt, agentEd25519 } from '../wallets.mjs';
import { BASE_CHAIN_ID, BASE_USDC, AUTH_TYPES, USDC_DOMAIN, authorization, settleRequest } from './x402.mjs';

const CHAIN_ID = 5042002;
// From deployments/5042002.json.
const IDENTITY = '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd';
const REPUTATION = '0x6603C96275e85F724Cdf74666b399365e4cA29ed';
const STAKING = '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B';
const SVR = '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c';
// The ERC-8004 registries on Arc testnet, as the publisher uses them (oracle/signer.js).
const ERC8004_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ERC8004_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

const env = process.env;
const SEED = env.SIM_SEED || 'sigvara-testnet-sim-2';
const STATE_FILE = env.SIM_STATE_FILE || 'sim2-state.json';
const RPC = env.SIM_RPC_URL || 'https://rpc.testnet.arc.io';
const BASE_RPC = env.SIM_BASE_RPC_URL || 'https://sepolia.base.org';
const ORACLE = env.SIM_ORACLE_URL || 'https://oracle.sigvara.xyz';
const COUNTERAUDIT = env.SIM_COUNTERAUDIT_URL || 'https://api.counteraudit.io';
const PAUSE_FILE = env.SIM_PAUSE_FILE || 'sim2-pause';
// Who submits Base Sepolia transfers: the public x402 testnet facilitator, which pays the gas, or with
// `self` the treasury, which then needs Base Sepolia ETH.
const FACILITATOR = env.SIM_X402_FACILITATOR || 'https://x402.org/facilitator';
const RESOURCE = 'https://sigvara.xyz/simulation?batch=2';
// Native USDC (18 decimals) for gas on Arc. A wallet that funds a reviewer, or a ring customer, sends
// at least FUNDER_GRANT, since only a transfer of 1 USDC or more names its sender as the funder.
const GAS_GRANT = ethers.parseEther('0.25');
const FUNDER_GRANT = ethers.parseEther('1.1');
const REVIEWER_GRANT = ethers.parseEther('2');
// Base Sepolia USDC (6 decimals) each Base customer starts with, and the top-up when it runs low.
const BASE_GRANT = 3_000_000n;
const BASE_TOPUP = 2_000_000n;
const FAUCET_AMOUNT = ethers.parseEther('10000');
// A Base payment is final after about a quarter of an hour; its outcome is posted after this.
const BASE_POST_DELAY_S = 20 * 60;
const LOOP_MS = 5 * 60 * 1000;
const STATUS = { Active: 0, Suspended: 1 };
// What a reviewed agent's ERC-8004 registration says about itself.
const AGENT_URI = 'data:application/json;base64,' + Buffer.from(JSON.stringify({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Sigvara simulation agent',
  description: 'A simulated agent in Sigvara\'s testnet simulation (batch 2). It does no real work. See https://github.com/RunTimeAdmin/Sigvara/blob/main/docs/simulation.md',
})).toString('base64');

const SVR_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function faucet(uint256)',
  'function lastFaucetUse(address) view returns (uint256)',
];
const STAKING_ABI = [
  'function minimumStake() view returns (uint256)',
  'function getStake(bytes32) view returns (uint256)',
  'function initiateWithdrawal(bytes32,uint256)',
];
const IDENTITY_ABI = [
  'function identities(bytes32) view returns (address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt)',
  'function pendingOperator(bytes32) view returns (address)',
  'function offerOperatorTransfer(bytes32,address)',
  'function acceptOperatorTransfer(bytes32)',
  'function updateStatus(bytes32,uint8)',
];
const ERC8004_IDENTITY_ABI = [
  'function register(string agentURI) returns (uint256)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const ERC8004_REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
];

const cast = buildCast(rng(`${SEED}:cast`));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- state: which actions are done, outcomes waiting to be posted, ERC-8004 links ----
function loadState() {
  if (!existsSync(STATE_FILE)) return { seed: SEED, start: null, done: {}, skipped: 0, outcomes: {}, links: {} };
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (s.seed !== SEED) throw new Error(`${STATE_FILE} belongs to seed ${s.seed}, not ${SEED}`);
  return s;
}
function saveState(s) {
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 1));
  renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// ---- wallets ----
function wallets(provider, baseProvider) {
  const phrase = loadMnemonic(env.SIM_MNEMONIC_FILE || (() => { throw new Error('SIM_MNEMONIC_FILE is not set'); })());
  const arc = new Map(), base = new Map();
  const at = (i) => { if (!arc.has(i)) arc.set(i, walletAt(phrase, i, provider)); return arc.get(i); };
  const onBase = (i) => { if (!base.has(i)) base.set(i, walletAt(phrase, i, baseProvider)); return base.get(i); };
  const didOf = (agentId) => computeDidHash(at(agentId).address, CHAIN_ID).toLowerCase();
  return { at, onBase, didOf };
}

// ---- the public list of everything this batch controls ----
function registry(w) {
  const opName = (id) => cast.operators.find((o) => o.id === id).name;
  return {
    note: 'Every address the second batch of Sigvara\'s testnet simulation controls. Activity from these is simulated, not outside demand. See docs/simulation.md.',
    batch: 2,
    chainIds: [CHAIN_ID, BASE_CHAIN_ID],
    seed: SEED,
    treasury: w.at(cast.treasury).address,
    hub: w.at(cast.hub).address,
    operators: cast.operators.map((o) => ({ name: o.name, address: w.at(o.id).address })),
    agents: cast.agents.map((a) => ({
      address: w.at(a.id).address, didHash: w.didOf(a.id), profile: a.group, day: a.day, operator: opName(a.operator),
    })),
    payers: cast.payers.map((p) => ({ address: w.at(p.id).address, chain: p.chain })),
    ringPayers: cast.ringPayers.map((p) => w.at(p.id).address),
    ringOperator: w.at(cast.ringOperator).address,
    reviewers: [...REVIEW.shared, REVIEW.operatorFunded].map((r) => ({
      address: w.at(r).address, funder: r === REVIEW.operatorFunded ? 'reviewed operator' : 'batch 2 treasury',
    })),
  };
}

// ---- one hour ----
async function tick(state) {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID, { staticNetwork: true });
  const w = wallets(provider, baseProvider);
  if (existsSync(PAUSE_FILE)) { log(`paused: ${PAUSE_FILE} exists`); return true; }
  if (!state.start) { state.start = Math.floor(Date.now() / 3600000) * 3600; saveState(state); }
  const h = Math.floor((Date.now() / 1000 - state.start) / 3600);
  if (h >= HOURS) { log(`batch over (${HOURS} hours since ${new Date(state.start * 1000).toISOString()})`); return false; }

  const svr = (signer) => new ethers.Contract(SVR, SVR_ABI, signer ?? provider);
  const staking = (signer) => new ethers.Contract(STAKING, STAKING_ABI, signer ?? provider);
  const identity = (signer) => new ethers.Contract(IDENTITY, IDENTITY_ABI, signer ?? provider);
  const usdc = (signer) => new ethers.Contract(BASE_USDC, USDC_ABI, signer ?? baseProvider);
  const agentIds = new Set(cast.agents.map((a) => a.id));
  const isRingPayer = (id) => cast.ringPayers.some((p) => p.id === id);

  const actions = [];
  for (let k = 0; k <= h; k++) {
    for (const a of planHour(cast, SEED, k)) {
      if (state.done[a.id]) continue;
      if (RETRIED.has(a.type) || k === h) actions.push(a);
    }
  }
  const done = (a, extra = {}) => { state.done[a.id] = { at: new Date().toISOString(), ...extra }; saveState(state); };
  const isDone = (id) => Boolean(state.done[id]);

  async function svrFor(wallet, amount) {
    const token = svr(wallet);
    if ((await token.balanceOf(wallet.address)) >= amount) return true;
    const last = Number(await token.lastFaucetUse(wallet.address));
    if (last && Date.now() / 1000 < last + 86400) return false;
    await (await token.faucet(FAUCET_AMOUNT)).wait();
    return (await token.balanceOf(wallet.address)) >= amount;
  }
  // Who funds a wallet's gas on Arc: the ring's customers by the hub, the hub by the ring's operator,
  // everyone else by the treasury.
  const funderOf = (id) => (isRingPayer(id) ? cast.hub : id === cast.hub ? cast.ringOperator : cast.treasury);
  const grantFor = (id) => (id === cast.hub ? FUNDER_GRANT * BigInt(cast.ringPayers.length + 1)
    : id === cast.ringOperator ? FUNDER_GRANT * BigInt(cast.ringPayers.length + 2)
      : id === cast.reviewedOperator ? REVIEWER_GRANT * 2n
        : isRingPayer(id) ? FUNDER_GRANT : GAS_GRANT);

  for (const a of actions) {
    if (existsSync(PAUSE_FILE)) { log(`paused: ${PAUSE_FILE} exists, the rest of this hour is left`); break; }
    try {
      if (a.type === 'fund') {
        const from = funderOf(a.wallet);
        if (from !== cast.treasury && !isDone(`fund:${from}`)) continue;
        const to = w.at(a.wallet), amount = grantFor(a.wallet);
        if ((await provider.getBalance(to.address)) >= amount / 2n) { done(a, { note: 'already funded' }); continue; }
        const tx = await w.at(from).sendTransaction({ to: to.address, value: amount });
        await tx.wait();
        done(a, { tx: tx.hash });
        log(`funded ${to.address} with ${ethers.formatEther(amount)} USDC on Arc`);
      } else if (a.type === 'fund-base') {
        const to = w.onBase(a.wallet).address;
        if ((await usdc().balanceOf(to)) >= BASE_GRANT / 2n) { done(a, { note: 'already funded' }); continue; }
        const tx = await settleUsdc(w.onBase(cast.treasury), to, BASE_GRANT, a.id, usdc, w.onBase(cast.treasury));
        done(a, { tx });
        log(`funded ${to} with ${Number(BASE_GRANT) / 1e6} USDC on Base Sepolia`);
      } else if (a.type === 'register') {
        if (!isDone(`fund:${a.operator}`)) continue;
        const op = w.at(a.operator), agent = w.at(a.agent);
        const ident = await identity().identities(w.didOf(a.agent));
        if (ident.registeredAt > 0n) { done(a, { note: 'already registered' }); continue; }
        const r = await registerAgent(op, agent.address, agentEd25519(agent), IDENTITY, { agentSigner: agent });
        done(a, { tx: r.txHash, didHash: r.didHash });
        log(`registered ${agent.address} (${cast.agents.find((x) => x.id === a.agent).group})`);
      } else if (a.type === 'stake') {
        if (!isDone(`register:${a.agent}`)) continue;
        const op = w.at(a.operator), did = w.didOf(a.agent);
        const min = await staking().minimumStake();
        if ((await staking().getStake(did)) >= min) { done(a, { note: 'already bonded' }); continue; }
        if (!(await svrFor(op, min))) { log(`stake for ${w.at(a.agent).address} waits for the operator's faucet cooldown`); continue; }
        const r = await depositStake(op, did, min, STAKING);
        done(a, { tx: r.txHash });
        log(`bonded ${w.at(a.agent).address} with ${ethers.formatEther(min)} SVR`);
      } else if (a.type === 'link') {
        await link(a, state, w, done);
      } else if (a.type === 'pay') {
        await pay(a, state, w, { svr, usdc, svrFor, provider, funderOf, agentIds, done });
      } else if (a.type === 'offer-transfer' || a.type === 'accept-transfer') {
        if (!isDone(`stake:${a.agent}`)) continue;
        const did = w.didOf(a.agent);
        const to = w.at(a.to).address;
        if ((await identity().identities(did)).operator === to) { done(a, { note: 'already transferred' }); continue; }
        if (a.type === 'offer-transfer') {
          if ((await identity().pendingOperator(did)) === to) { done(a, { note: 'already offered' }); continue; }
          const tx = await identity(w.at(a.from)).offerOperatorTransfer(did, to);
          await tx.wait();
          done(a, { tx: tx.hash });
          log(`offered ${w.at(a.agent).address} to ${to}`);
        } else {
          if (!isDone('handover:offer')) continue;
          const tx = await identity(w.at(a.to)).acceptOperatorTransfer(did);
          await tx.wait();
          done(a, { tx: tx.hash });
          log(`${to} is now the operator of ${w.at(a.agent).address}`);
        }
      } else if (a.type === 'leave-bond') {
        if (!isDone(`stake:${a.agent}`)) continue;
        const agent = cast.agents.find((x) => x.id === a.agent), op = w.at(agent.operator), did = w.didOf(a.agent);
        if (Number((await identity().identities(did)).status) === STATUS.Active) {
          await (await identity(op).updateStatus(did, STATUS.Suspended)).wait();
          log(`suspended ${w.at(a.agent).address}`);
        }
        const stake = await staking().getStake(did);
        let tx = null;
        if (stake > 0n) {
          tx = await staking(op).initiateWithdrawal(did, stake);
          await tx.wait();
        }
        done(a, { tx: tx?.hash ?? null, withdrawn: ethers.formatEther(stake) });
        log(`${w.at(a.agent).address} withdrew its whole bond (${ethers.formatEther(stake)} SVR)`);
      } else if (a.type === 'rebond') {
        if (!isDone('bonding:leave')) continue;
        const agent = cast.agents.find((x) => x.id === a.agent), op = w.at(agent.operator), did = w.didOf(a.agent);
        const min = await staking().minimumStake();
        if ((await staking().getStake(did)) < min) {
          if (!(await svrFor(op, min))) { log('the rebond waits for the operator\'s faucet cooldown'); continue; }
          await depositStake(op, did, min, STAKING);
        }
        let tx = null;
        if (Number((await identity().identities(did)).status) !== STATUS.Active) {
          tx = await identity(op).updateStatus(did, STATUS.Active);
          await tx.wait();
        }
        done(a, { tx: tx?.hash ?? null });
        log(`${w.at(a.agent).address} bonded again and is Active`);
      } else if (a.type === 'review-fund') {
        if (![...REVIEW.shared, REVIEW.operatorFunded].includes(a.reviewer)) throw new Error(`${a.reviewer} is not a reviewer`);
        if (!isDone(`fund:${a.from}`)) continue;
        const to = w.at(a.reviewer).address;
        const prior = await provider.getBalance(to);
        if (prior >= REVIEWER_GRANT / 2n) { done(a, { note: 'already funded', prior: ethers.formatEther(prior) }); continue; }
        const tx = await w.at(a.from).sendTransaction({ to, value: REVIEWER_GRANT });
        await tx.wait();
        // A balance before the grant means something else may have named itself the funder first.
        done(a, { tx: tx.hash, prior: ethers.formatEther(prior) });
        log(`funded reviewer ${to} from ${a.from === cast.treasury ? 'the treasury' : 'the reviewed agents\' operator'}`);
      } else if (a.type === 'review-pay') {
        if (!cast.reviewed.includes(a.agent)) throw new Error(`refusing to pay ${a.agent}, which is not a reviewed agent`);
        if (!isDone(`review-fund:${a.reviewer}`) || !isDone(`stake:${a.agent}`)) continue;
        const reviewer = w.at(a.reviewer), amount = ethers.parseEther(String(a.amount));
        if (!(await svrFor(reviewer, amount))) { log(`reviewer ${reviewer.address} waits for its faucet cooldown`); continue; }
        const tx = await svr(reviewer).transfer(w.at(a.agent).address, amount);
        done(a, { tx: tx.hash });
        await tx.wait(2);
        log(`reviewer ${reviewer.address} paid ${a.amount} SVR to ${w.at(a.agent).address}`);
      } else if (a.type === 'review-post') {
        const agentId = state.links[a.agent]?.agentId;
        if (!isDone(`link:${a.agent}`) || !agentId || !isDone(`review-pay:${a.reviewer}:${a.agent}`)) continue;
        const rep = new ethers.Contract(ERC8004_REPUTATION, ERC8004_REPUTATION_ABI, w.at(a.reviewer));
        const tx = await rep.giveFeedback(BigInt(agentId), a.rating, 0, 'starred', '', '', '', ethers.ZeroHash);
        await tx.wait();
        done(a, { tx: tx.hash, agentId });
        log(`reviewer ${w.at(a.reviewer).address} rated ERC-8004 agent ${agentId} ${a.rating}`);
      }
    } catch (e) {
      log(`${a.id} failed: ${e.shortMessage ?? e.message}`);
    }
  }
  await postOutcomes(state);
  return true;
}

// An ERC-8004 identity for a reviewed agent, owned by its operator, with `sigvara` set to its didHash
// (docs/integration.md). Two steps, each recorded, so a retry never registers a second identity.
async function link(a, state, w, done) {
  if (!state.done[`stake:${a.agent}`]) return;
  const op = w.at(a.operator), did = w.didOf(a.agent);
  const reg = new ethers.Contract(ERC8004_IDENTITY, ERC8004_IDENTITY_ABI, op);
  let entry = state.links[a.agent];
  if (!entry?.agentId) {
    if (entry?.registerTx) {
      // Sent before and not recorded: read the id from that transaction rather than register again.
      const receipt = await op.provider.getTransactionReceipt(entry.registerTx);
      if (!receipt) return;
      entry.agentId = mintedId(receipt, op.address);
    } else {
      const tx = await reg.register(AGENT_URI);
      entry = state.links[a.agent] = { registerTx: tx.hash };
      saveState(state);
      entry.agentId = mintedId(await tx.wait(), op.address);
    }
    saveState(state);
    log(`registered ERC-8004 agent ${entry.agentId} for ${w.at(a.agent).address}`);
  }
  if (ethers.hexlify(await reg.getMetadata(BigInt(entry.agentId), 'sigvara')).toLowerCase() !== did) {
    await (await reg.setMetadata(BigInt(entry.agentId), 'sigvara', did)).wait();
  }
  done(a, { agentId: entry.agentId });
  log(`ERC-8004 agent ${entry.agentId} names ${w.at(a.agent).address}`);
}

function mintedId(receipt, owner) {
  const iface = new ethers.Interface(ERC8004_IDENTITY_ABI);
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== ERC8004_IDENTITY.toLowerCase()) continue;
    try {
      const p = iface.parseLog(l);
      if (p?.name === 'Transfer' && p.args.from === ethers.ZeroAddress && p.args.to.toLowerCase() === owner.toLowerCase()) return p.args.tokenId.toString();
    } catch { /* another event */ }
  }
  throw new Error(`no ERC-8004 identity minted to ${owner} in ${receipt.hash}`);
}

// One job: the payment on its chain, then, if its payer posts one, a signed outcome queued for posting.
async function pay(a, state, w, { svr, usdc, svrFor, provider, funderOf, agentIds, done }) {
  if (!agentIds.has(a.agent)) throw new Error(`refusing to pay ${a.agent}, which is not in the cast`);
  const ready = state.done[`stake:${a.agent}`] && state.done[a.chain === 'base' ? `fund-base:${a.payer}` : `fund:${a.payer}`];
  if (!ready) { state.skipped++; done(a, { skipped: 'not ready' }); return; }
  const agent = w.at(a.agent).address, did = w.didOf(a.agent);
  let txHash;
  if (a.chain === 'arc') {
    const payer = w.at(a.payer), amount = ethers.parseEther(String(a.amount));
    if ((await provider.getBalance(payer.address)) < GAS_GRANT / 10n) {
      await (await w.at(funderOf(a.payer)).sendTransaction({ to: payer.address, value: GAS_GRANT })).wait();
      log(`topped up ${payer.address} with ${ethers.formatEther(GAS_GRANT)} USDC on Arc`);
    }
    if (!(await svrFor(payer, amount))) { state.skipped++; done(a, { skipped: 'no SVR until the faucet cooldown ends' }); return; }
    const tx = await svr(payer).transfer(agent, amount);
    txHash = tx.hash;
    done(a, { tx: txHash, amount: a.amount, delivered: a.delivered });
    await tx.wait(2);
  } else {
    // An x402 exact-scheme payment (x402.mjs): the payer signs, the facilitator submits.
    const payer = w.onBase(a.payer), treasury = w.onBase(cast.treasury);
    const value = BigInt(a.amount) * 10_000n;
    if ((await usdc().balanceOf(payer.address)) < value) {
      await settleUsdc(treasury, payer.address, BASE_TOPUP, `topup:${a.id}`, usdc, treasury);
      log(`topped up ${payer.address} with ${Number(BASE_TOPUP) / 1e6} USDC on Base Sepolia`);
    }
    txHash = await settleUsdc(payer, agent, value, a.id, usdc, treasury);
    if (!txHash) { done(a, { note: 'authorization already used' }); return; }
    done(a, { tx: txHash, cents: a.amount, delivered: a.delivered });
  }
  if (a.post) {
    const chainId = a.chain === 'base' ? BASE_CHAIN_ID : CHAIN_ID;
    const payerOutcome = await signPaymentOutcome(a.chain === 'base' ? w.onBase(a.payer) : w.at(a.payer), {
      didHash: did, txHash, outcome: OUTCOME_DELIVERED, chainId, reputationAddress: REPUTATION,
    });
    const body = { didHash: did, payment: a.chain === 'base' ? { txHash, chainId } : { txHash }, payerOutcome };
    const notBefore = Math.floor(Date.now() / 1000) + (a.chain === 'base' ? BASE_POST_DELAY_S : 0);
    state.outcomes[a.id] = { body, via: a.via, notBefore, deadline: payerOutcome.deadline, tries: 0 };
    saveState(state);
  }
  log(`${w.at(a.payer).address} paid ${a.chain === 'base' ? `${a.amount} cents of USDC on Base` : `${a.amount} SVR on Arc`} to ${agent}${a.tag ? ` (${a.tag})` : ''}`);
}

// Moves `value` USDC on Base Sepolia from `from` (a wallet) to `to` by an EIP-3009 authorization that
// `from` signs, submitted by the facilitator, or by `treasury` when FACILITATOR is `self`. Returns the
// transaction hash once it is mined, or null when this key's authorization was already used, which
// means an earlier try went through without being recorded.
async function settleUsdc(from, to, value, key, usdc, treasury) {
  const auth = authorization({ from: from.address, to, value, key, seed: SEED, nowS: Math.floor(Date.now() / 1000) });
  if (await usdc().authorizationState(auth.from, auth.nonce)) return null;
  const signature = await from.signTypedData(USDC_DOMAIN, AUTH_TYPES, auth);
  if (FACILITATOR === 'self') {
    const sig = ethers.Signature.from(signature);
    const tx = await usdc(treasury).transferWithAuthorization(
      auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s);
    await tx.wait();
    return tx.hash;
  }
  const res = await fetch(`${FACILITATOR}/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settleRequest(auth, signature, RESOURCE)),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || !answer.success || !answer.transaction) {
    throw new Error(`facilitator refused: ${answer.errorReason ?? answer.error ?? res.status}`);
  }
  return answer.transaction;
}

// Posts each queued outcome once its payment can be read, to the oracle or through CounterAudit. A 2xx
// or 4xx answer is final and recorded; anything else is tried again next tick until the deadline.
async function postOutcomes(state) {
  const key = env.SIM_COUNTERAUDIT_KEY_FILE && existsSync(env.SIM_COUNTERAUDIT_KEY_FILE)
    ? readFileSync(env.SIM_COUNTERAUDIT_KEY_FILE, 'utf8').trim() : null;
  const now = Math.floor(Date.now() / 1000);
  for (const [id, o] of Object.entries(state.outcomes)) {
    if (o.status || now < o.notBefore) continue;
    if (existsSync(PAUSE_FILE)) break;
    if (now > Number(o.deadline)) { o.status = 'expired'; saveState(state); continue; }
    const via = o.via === 'counteraudit' && key ? 'counteraudit' : 'oracle';
    try {
      const res = via === 'counteraudit'
        ? await fetch(`${COUNTERAUDIT}/v1/audit/ingest`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ connector_id: 'sigvara-payment-outcome-v1', raw_event: o.body }),
        })
        : await fetch(`${ORACLE}/attest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) });
      o.tries++;
      const answer = await res.json().catch(() => ({}));
      // A refused key or a rate limit says nothing about the outcome, so it is tried again.
      const retry = res.status >= 500 || res.status === 429 || (via === 'counteraudit' && [401, 403].includes(res.status));
      if (retry) log(`outcome for ${id} via ${via}: ${res.status}, trying again next tick`);
      else {
        o.status = res.status;
        o.sentVia = via;
        o.code = answer.code ?? answer.error ?? null;
        if (via === 'counteraudit') o.forwarded = answer.forwarded ?? null;
        log(`outcome for ${id} via ${via}: ${res.status}${o.code ? ` ${o.code}` : ''}`);
      }
    } catch (e) {
      o.tries++;
      log(`outcome for ${id} via ${via} failed: ${e.message}`);
    }
    saveState(state);
  }
}

// ---- cli ----
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'plan') {
  const state = existsSync(STATE_FILE) ? loadState() : { start: null };
  const from = state.start ? Math.floor((Date.now() / 1000 - state.start) / 3600) : 0;
  for (let h = from; h < from + Number(arg || 24); h++) {
    for (const a of planHour(cast, SEED, h)) console.log(`hour ${h}`, JSON.stringify(a));
  }
} else if (cmd === 'registry') {
  process.stdout.write(JSON.stringify(registry(wallets()), null, 2) + '\n');
} else if (cmd === 'tick') {
  await tick(loadState());
} else if (cmd === 'loop') {
  const state = loadState();
  for (;;) {
    if (!(await tick(state))) break;
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
} else {
  console.error('usage: node sim/src/batch2/run.mjs plan [hours] | registry | tick | loop');
  process.exit(2);
}
