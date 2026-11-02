// The simulation runner. See docs/simulation.md.
//
//   node sim/src/run.mjs plan [hours]   the actions of the next hours, without a chain or keys
//   node sim/src/run.mjs registry       every address the simulation controls, as public JSON
//   node sim/src/run.mjs tick           carry out the current hour, then exit
//   node sim/src/run.mjs loop           tick every few minutes until the run ends
//
// Environment: SIM_MNEMONIC_FILE (required for registry, tick, loop), SIM_STATE_FILE
// (default sim-state.json), SIM_SEED, SIM_RPC_URL, SIM_ORACLE_URL, SIM_PAUSE_FILE (while it exists,
// nothing is sent), SIM_MANUAL_FILE (the steps only the committee or admin key can take).
//
// It acts only on the cast: every payment goes to a cast agent, and enforcement touches only the
// ring. It stops by itself after DAYS days.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { ethers } from 'ethers';
import { registerAgent, depositStake, signPaymentOutcome, computeDidHash, OUTCOME_DELIVERED } from '@sigvara/protocol-sdk';
import { buildCast } from './cast.mjs';
import { planHour, HOURS, SLASHES } from './plan.mjs';
import { rng } from './rng.mjs';
import { loadMnemonic, walletAt, agentEd25519 } from './wallets.mjs';

const CHAIN_ID = 5042002;
// From deployments/5042002.json.
const IDENTITY = '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd';
const REPUTATION = '0x6603C96275e85F724Cdf74666b399365e4cA29ed';
const STAKING = '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B';
const SVR = '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c';

const env = process.env;
const SEED = env.SIM_SEED || 'sigvara-testnet-sim-1';
const STATE_FILE = env.SIM_STATE_FILE || 'sim-state.json';
const RPC = env.SIM_RPC_URL || 'https://rpc.testnet.arc.io';
const ORACLE = env.SIM_ORACLE_URL || 'https://oracle.sigvara.xyz';
const PAUSE_FILE = env.SIM_PAUSE_FILE || 'sim-pause';
const MANUAL_FILE = env.SIM_MANUAL_FILE || 'sim-manual-steps.md';
// Native USDC (18 decimals) each wallet gets for gas. A payment costs about 0.001.
const GAS_GRANT = ethers.parseEther(env.SIM_GAS_GRANT || '0.25');
const FAUCET_AMOUNT = ethers.parseEther('10000');
const LOOP_MS = 5 * 60 * 1000;
// What the committee files against a ring agent, in plain text so the explorer can show it.
const RING_EVIDENCE = 'sim: Sybil ring. Its customers are funded by the ring operator and pay only the ring. See docs/simulation.md.';

const SVR_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function faucet(uint256)',
  'function lastFaucetUse(address) view returns (uint256)',
];
const STAKING_ABI = [
  'function minimumStake() view returns (uint256)',
  'function getStake(bytes32) view returns (uint256)',
  'function disputeSlash(bytes32)',
  'function executeSlash(bytes32)',
  'function getSlashProposal(bytes32) view returns (tuple(bytes32 didHash, address reporter, address victim, uint256 initiatedAt, uint8 state, bytes evidenceHash, uint256 challengeDeadline, uint256 disputedAt))',
];
const IDENTITY_ABI = ['function identities(bytes32) view returns (address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt)'];
const SLASH_STATE = ['None', 'Pending', 'Executed', 'Cancelled', 'Disputed'];

const cast = buildCast(rng(`${SEED}:cast`));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- state: which actions are done, when the run started ----
function loadState() {
  if (!existsSync(STATE_FILE)) return { seed: SEED, start: null, done: {}, skipped: 0, manual: {} };
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (s.seed !== SEED) throw new Error(`${STATE_FILE} belongs to seed ${s.seed}, not ${SEED}`);
  return s;
}
function saveState(s) {
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 1));
  renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// ---- wallets ----
function wallets(provider) {
  const phrase = loadMnemonic(env.SIM_MNEMONIC_FILE || (() => { throw new Error('SIM_MNEMONIC_FILE is not set'); })());
  const cache = new Map();
  const at = (i) => { if (!cache.has(i)) cache.set(i, walletAt(phrase, i, provider)); return cache.get(i); };
  const didOf = (agentId) => computeDidHash(at(agentId).address, CHAIN_ID).toLowerCase();
  return { at, didOf };
}

// ---- the public list of everything the simulation controls ----
function registry(w) {
  const ringOp = cast.operators.find((o) => o.name === 'ring');
  return {
    note: 'Every address Sigvara\'s testnet simulation controls. Activity from these is simulated, not outside demand. See docs/simulation.md.',
    chainId: CHAIN_ID,
    seed: SEED,
    treasury: w.at(cast.treasury).address,
    operators: cast.operators.map((o) => ({ name: o.name, address: w.at(o.id).address })),
    agents: cast.agents.map((a) => ({
      address: w.at(a.id).address, didHash: w.didOf(a.id), profile: a.profile, day: a.day,
      operator: cast.operators.find((o) => o.id === a.operator).name,
    })),
    payers: cast.payers.map((p) => w.at(p.id).address),
    ringPayers: cast.ringPayers.map((p) => w.at(p.id).address),
    ringOperator: w.at(ringOp.id).address,
  };
}

// ---- one hour ----
async function tick(state, opts = {}) {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const w = wallets(provider);
  if (!state.start) { state.start = Math.floor(Date.now() / 3600000) * 3600; saveState(state); }
  const h = Math.floor((Date.now() / 1000 - state.start) / 3600);
  if (h >= HOURS) { log(`run over (${HOURS} hours since ${new Date(state.start * 1000).toISOString()})`); return false; }
  if (existsSync(PAUSE_FILE)) { log(`paused: ${PAUSE_FILE} exists`); return true; }

  const svr = (signer) => new ethers.Contract(SVR, SVR_ABI, signer ?? provider);
  const staking = (signer) => new ethers.Contract(STAKING, STAKING_ABI, signer ?? provider);
  const agentIds = new Set(cast.agents.map((a) => a.id));
  const ringOp = cast.operators.find((o) => o.name === 'ring');

  // Setup is retried until it is done, whatever hour it was planned for; a job belongs to its hour
  // and is skipped, not made up, once the hour has passed.
  const actions = [];
  for (let k = 0; k <= h; k++) {
    for (const a of planHour(cast, SEED, k)) {
      if (state.done[a.id]) continue;
      if (['fund', 'register', 'stake', 'manual'].includes(a.type) || k === h) actions.push(a);
    }
  }
  const done = (a, extra = {}) => { state.done[a.id] = { at: new Date().toISOString(), ...extra }; saveState(state); };

  async function svrFor(wallet, amount) {
    const token = svr(wallet);
    if ((await token.balanceOf(wallet.address)) >= amount) return true;
    const last = Number(await token.lastFaucetUse(wallet.address));
    if (last && Date.now() / 1000 < last + 86400) return false;
    await (await token.faucet(FAUCET_AMOUNT)).wait();
    return (await token.balanceOf(wallet.address)) >= amount;
  }

  for (const a of actions) {
    try {
      if (a.type === 'fund') {
        // The ring's customers are funded by the ring's operator, not the treasury, so the money
        // trail an investigator would follow leads back to the ring.
        const isRingPayer = cast.ringPayers.some((p) => p.id === a.wallet);
        const from = w.at(isRingPayer ? ringOp.id : cast.treasury);
        const to = w.at(a.wallet);
        if ((await provider.getBalance(to.address)) >= GAS_GRANT / 2n) { done(a, { note: 'already funded' }); continue; }
        if (isRingPayer && !state.done[`fund:${ringOp.id}`]) continue;
        const amount = isRingPayer ? GAS_GRANT : a.wallet === ringOp.id ? GAS_GRANT * BigInt(cast.ringPayers.length + 1) : GAS_GRANT;
        const tx = await from.sendTransaction({ to: to.address, value: amount });
        await tx.wait();
        done(a, { tx: tx.hash });
        log(`funded ${to.address} with ${ethers.formatEther(amount)} USDC for gas`);
      } else if (a.type === 'register') {
        if (!state.done[`fund:${a.operator}`]) continue;
        const op = w.at(a.operator), agent = w.at(a.agent);
        const ident = await new ethers.Contract(IDENTITY, IDENTITY_ABI, provider).identities(w.didOf(a.agent));
        if (ident.registeredAt > 0n) { done(a, { note: 'already registered' }); continue; }
        const r = await registerAgent(op, agent.address, agentEd25519(agent), IDENTITY, { agentSigner: agent });
        done(a, { tx: r.txHash, didHash: r.didHash });
        log(`registered ${agent.address} (${cast.agents.find((x) => x.id === a.agent).profile})`);
      } else if (a.type === 'stake') {
        if (!state.done[`register:${a.agent}`]) continue;
        const op = w.at(a.operator), did = w.didOf(a.agent);
        const min = await staking().minimumStake();
        if ((await staking().getStake(did)) >= min) { done(a, { note: 'already bonded' }); continue; }
        if (!(await svrFor(op, min))) { log(`stake for ${w.at(a.agent).address} waits for the operator's faucet cooldown`); continue; }
        const r = await depositStake(op, did, min, STAKING);
        done(a, { tx: r.txHash });
        log(`bonded ${w.at(a.agent).address} with ${ethers.formatEther(min)} SVR`);
      } else if (a.type === 'pay') {
        if (!agentIds.has(a.agent)) throw new Error(`refusing to pay ${a.agent}, which is not in the cast`);
        if (!state.done[`stake:${a.agent}`] || !state.done[`fund:${a.payer}`]) { state.skipped++; done(a, { skipped: 'not ready' }); continue; }
        const payer = w.at(a.payer), agent = w.at(a.agent), amount = ethers.parseEther(String(a.amount));
        // A wallet running low on gas is topped up by whoever funded it.
        if ((await provider.getBalance(payer.address)) < GAS_GRANT / 10n) {
          const funder = w.at(cast.ringPayers.some((p) => p.id === a.payer) ? ringOp.id : cast.treasury);
          await (await funder.sendTransaction({ to: payer.address, value: GAS_GRANT })).wait();
          log(`topped up ${payer.address} with ${ethers.formatEther(GAS_GRANT)} USDC for gas`);
        }
        if (!(await svrFor(payer, amount))) { state.skipped++; done(a, { skipped: 'no SVR until the faucet cooldown ends' }); continue; }
        const tx = await svr(payer).transfer(agent.address, amount);
        await tx.wait(2);
        let posted = null;
        if (a.post) {
          const payerOutcome = await signPaymentOutcome(payer, {
            didHash: w.didOf(a.agent), txHash: tx.hash, outcome: OUTCOME_DELIVERED, chainId: CHAIN_ID, reputationAddress: REPUTATION,
          });
          const res = await fetch(`${ORACLE}/attest`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ didHash: w.didOf(a.agent), payment: { txHash: tx.hash }, payerOutcome }),
          });
          posted = res.status;
        }
        done(a, { tx: tx.hash, amount: a.amount, delivered: a.delivered, attest: posted });
        log(`${payer.address} paid ${a.amount} SVR to ${agent.address}, ${a.delivered ? 'delivered' : 'not delivered'}${posted ? `, outcome posted (${posted})` : ''}`);
      } else if (a.type === 'manual') {
        const did = w.didOf(a.agent);
        state.manual[a.agent] = { step: 'file-slash', since: new Date().toISOString(), did, dispute: a.dispute };
        done(a);
        writeManual(state, w);
      } else if (a.type === 'enforce') {
        await enforce(state, w, staking, ringOp);
        done(a);
      }
    } catch (e) {
      log(`${a.id} failed: ${e.shortMessage ?? e.message}`);
    }
  }
  return true;
}

// Disputes and executions the simulation may take for itself; anything needing the committee or the
// admin key goes to the manual steps file.
async function enforce(state, w, staking, ringOp) {
  for (const s of SLASHES) {
    const agentId = cast.agents.filter((a) => a.profile === 'ring')[s.ring].id;
    const did = w.didOf(agentId);
    const p = await staking().getSlashProposal(did);
    const st = SLASH_STATE[Number(p.state)];
    const m = state.manual[agentId];
    if (!m) continue;
    if (st === 'Pending' && s.dispute && !m.disputed) {
      const tx = await staking(w.at(ringOp.id)).disputeSlash(did);
      await tx.wait();
      m.disputed = tx.hash;
      m.step = 'rule-dispute';
      log(`ring operator disputed the slash of ${w.at(agentId).address}: ${tx.hash}`);
    } else if (st === 'Pending' && !s.dispute && Date.now() / 1000 > Number(p.challengeDeadline)) {
      const tx = await staking(w.at(cast.treasury)).executeSlash(did);
      await tx.wait();
      m.executed = tx.hash;
      m.step = 'done';
      log(`executed the slash of ${w.at(agentId).address}: ${tx.hash}`);
    } else if (st === 'Pending' && m.step === 'file-slash') {
      m.step = s.dispute ? 'awaiting-dispute' : 'awaiting-window';
    } else if (['Executed', 'Cancelled'].includes(st)) {
      m.step = 'done';
      m.outcome = st;
    }
    m.state = st;
    saveState(state);
  }
  writeManual(state, w);
}

function writeManual(state, w) {
  const victim = w.at(cast.treasury).address;
  const evidence = ethers.hexlify(ethers.toUtf8Bytes(RING_EVIDENCE));
  const lines = ['# Simulation: steps only the committee or admin key can take', '',
    `Updated ${new Date().toISOString()}. Run each from D:\\Sigvara with the key in the environment; the simulation takes every other step itself.`, ''];
  for (const [agentId, m] of Object.entries(state.manual)) {
    const addr = w.at(Number(agentId)).address;
    if (m.step === 'file-slash') {
      lines.push(`## File the slash of ring agent ${addr} (committee key)`, '', '```bash',
        `cast send ${STAKING} "initiateSlash(bytes32,address,bytes)" ${m.did} ${victim} ${evidence} --rpc-url ${RPC} --private-key $COMMITTEE_KEY`,
        '```', '', m.dispute ? 'The ring operator will dispute it within the hour; then the admin rules.' : 'Nobody will dispute it; the simulation executes it once the challenge window closes.', '');
    } else if (m.step === 'rule-dispute') {
      lines.push(`## Rule on the disputed slash of ring agent ${addr} (admin key)`, '',
        'Upholding needs the challenge deadline to have passed. To uphold:', '', '```bash',
        `cast send ${STAKING} "resolveDispute(bytes32,bool)" ${m.did} true --rpc-url ${RPC} --private-key $ADMIN_KEY`,
        '```', '');
    } else {
      lines.push(`## Ring agent ${addr}: ${m.step}${m.state ? ` (proposal ${m.state})` : ''}`, '');
    }
  }
  writeFileSync(MANUAL_FILE, lines.join('\n'));
}

// ---- cli ----
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'plan') {
  const state = existsSync(STATE_FILE) ? loadState() : { start: null };
  const from = state.start ? Math.floor((Date.now() / 1000 - state.start) / 3600) : 0;
  for (let h = from; h < from + Number(arg || 24); h++) {
    for (const a of planHour(cast, SEED, h)) if (a.type !== 'enforce') console.log(`hour ${h}`, JSON.stringify(a));
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
  console.error('usage: node sim/src/run.mjs plan [hours] | registry | tick | loop');
  process.exit(2);
}
