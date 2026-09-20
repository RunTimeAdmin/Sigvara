/**
 * Give a live agent a real trading history.
 *
 * The protocol has been exercised against one agent with two payments worth 23 SVR. Every
 * claim about the score resisting manipulation is measured in a test harness, and the live
 * deployment has never carried a number large enough for `meetsThreshold` to mean
 * anything. This funds a set of independent payer wallets, has each pay the agent, and
 * attests the settlements, so the fee and success factors are computed from real settled
 * volume from genuinely distinct counterparties.
 *
 *   node scripts/fat-path.mjs --agent 0x... --payers 6 --amount 500 --dry-run
 *   node scripts/fat-path.mjs --agent 0x... --payers 6 --amount 500
 *
 * Needs DEPLOYER_PRIVATE_KEY, which funds the payers. It owns SVRToken, so it mints what
 * it does not hold rather than draining itself.
 *
 * ## What this can and cannot move
 *
 * Reaching the 20-point fee cap takes 2,000 SVR of decayed volume with no single payer
 * contributing more than 5 points, which is 500 SVR at the default unit. That is why the
 * payers are separate wallets rather than one wallet paying repeatedly: `maxPerPayer` is
 * the cap that makes a payer count as a counterparty rather than as money, and paying
 * yourself six times is exactly what it exists to refuse.
 *
 * Tenure responds immediately but not much: the span runs from the agent's FIRST verified
 * payment, so paying today extends an existing span rather than starting one. It then
 * grows with the calendar and nothing here can hurry it.
 *
 * `externalScore` and `propagationScore` cannot be moved by this script at all. External
 * needs EXTERNAL_RPC/EXTERNAL_IDENTITY/EXTERNAL_REPUTATION pointing at an ERC-8004
 * deployment, and the live oracle has none, so it is structurally 0. Propagation reads
 * counterparties' hard standing, which IS their external score, so it is 0 for the same
 * reason. That is 30 of the 100 points switched off, and it is a configuration gap rather
 * than anything this script can close. Say so when quoting a resulting score.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

// ethers is a dependency of the oracle package, not of the repo root, and this script
// lives in scripts/. Resolving it explicitly beats adding a root package.json whose only
// purpose is to make one script's import work.
const require = createRequire(import.meta.url);
const { ethers } = require('../oracle/node_modules/ethers');

const RPC        = process.env.RPC_URL || 'https://rpc.testnet.arc.io';
const ORACLE     = process.env.ORACLE_URL || 'https://oracle.sigvara.xyz';
const SVR        = '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c';
const IDENTITY   = '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd';

/// The slash drill target. Paying it would build a history that gets destroyed on
/// 27 September, and worse, would muddy the drill's before/after.
const DRILL_TARGET = '0x59d75ab4a3af114de90c4f6640f4dc47cee83d0895f3f8c4eb9b012dc5f6e153';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const AGENT   = arg('agent');
const PAYERS  = Number(arg('payers', 6));
const AMOUNT  = Number(arg('amount', 500));      // SVR per payer
const GAS_EACH = ethers.parseEther(arg('gas', '0.05')); // native USDC per payer
// 0.05 is roughly ten times what an ERC-20 transfer costs on Arc, measured rather than
// guessed: two transactions from the checker wallet came to 0.004 in total.
const DRY     = has('dry-run');

const SVR_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function owner() view returns (address)',
];
const ID_ABI = [
  'function computeDidHash(address) view returns (bytes32)',
  'function identities(bytes32) view returns (address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt)',
];

const log = (...a) => console.log(...a);
const svrUnits = (n) => ethers.parseEther(String(n));

async function main() {
  if (!AGENT) throw new Error('--agent <address> is required');
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is not set');

  const provider = new ethers.JsonRpcProvider(RPC);
  const funder   = new ethers.Wallet(key, provider);
  const svr      = new ethers.Contract(SVR, SVR_ABI, funder);
  const identity = new ethers.Contract(IDENTITY, ID_ABI, provider);

  // ---- refuse to build a history on something about to be destroyed -----------
  const didHash = await identity.computeDidHash(AGENT);
  if (didHash.toLowerCase() === DRILL_TARGET.toLowerCase()) {
    throw new Error('that is the slash drill target; its history is destroyed on 27 September');
  }
  const id = await identity.identities(didHash);
  if (id.registeredAt === 0n) throw new Error(`agent ${AGENT} is not registered`);
  if (Number(id.status) !== 0) {
    throw new Error(`agent status is ${id.status}, not Active — an unbonded or suspended agent is not scored`);
  }

  log(`agent    ${AGENT}`);
  log(`didHash  ${didHash}`);
  log(`payers   ${PAYERS} x ${AMOUNT} SVR = ${PAYERS * AMOUNT} SVR`);
  log(`funder   ${funder.address}`);

  // ---- make sure the funder can actually cover it -----------------------------
  const needSvr = svrUnits(PAYERS * AMOUNT);
  const needGas = GAS_EACH * BigInt(PAYERS);
  const haveSvr = await svr.balanceOf(funder.address);
  const haveGas = await provider.getBalance(funder.address);
  log(`funder has ${ethers.formatEther(haveSvr)} SVR, ${ethers.formatEther(haveGas)} gas`);

  // Collect every problem rather than throwing on the first, so one dry run tells you
  // everything you need to fix instead of one thing per attempt.
  const problems = [];
  if (haveGas < needGas) {
    problems.push(`needs ${ethers.formatEther(needGas)} native for payer gas, has ${ethers.formatEther(haveGas)}`);
  }
  const toMint = haveSvr < needSvr ? needSvr - haveSvr : 0n;
  if (toMint > 0n) {
    const owner = await svr.owner();
    if (owner.toLowerCase() === funder.address.toLowerCase()) {
      log(`plan: mint ${ethers.formatEther(toMint)} SVR (funder owns the token)`);
    } else {
      problems.push(`short ${ethers.formatEther(toMint)} SVR and the funder does not own the token`);
    }
  }

  log(`\nprojected: fee +20 (at ${PAYERS} payers x ${AMOUNT} SVR), success rises with attestations,`);
  log(`           tenure extends the existing span, external and propagation stay 0 (EXTERNAL_* unset)`);

  if (problems.length) {
    log('\nblocked:');
    for (const w of problems) log(`  - ${w}`);
    if (!DRY) process.exit(1);
  }

  if (DRY) {
    log(problems.length ? '\n--dry-run: fix the above, then run without the flag.'
                        : '\n--dry-run: all checks passed. Drop the flag to execute.');
    return;
  }

  if (toMint > 0n) await (await svr.mint(funder.address, toMint)).wait(1);

  // ---- one wallet per payer ---------------------------------------------------
  // Distinct wallets, not one wallet paying repeatedly: maxPerPayer caps any single
  // counterparty at 5 points, so repeat payments from one address are refused the
  // headroom by design.
  const payers = Array.from({ length: PAYERS }, () => ethers.Wallet.createRandom().connect(provider));
  const record = { agent: AGENT, didHash, at: new Date().toISOString(), payments: [] };

  for (const [i, p] of payers.entries()) {
    log(`\npayer ${i + 1}/${PAYERS}  ${p.address}`);
    await (await funder.sendTransaction({ to: p.address, value: GAS_EACH })).wait(1);
    await (await svr.transfer(p.address, svrUnits(AMOUNT))).wait(1);

    const tx = await new ethers.Contract(SVR, SVR_ABI, p).transfer(AGENT, svrUnits(AMOUNT));
    const receipt = await tx.wait(1);
    log(`  paid ${AMOUNT} SVR  tx=${receipt.hash}`);
    record.payments.push({ payer: p.address, amount: AMOUNT, txHash: receipt.hash });

    // The oracle reads the payer off the transfer log and re-verifies the transaction
    // against the chain, so this asserts nothing it cannot check. No token needed: the
    // payment IS the credential.
    const res = await fetch(`${ORACLE}/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ didHash, success: true, payment: { txHash: receipt.hash } }),
    });
    const body = await res.json().catch(() => ({}));
    log(`  attested ${res.status} ${body.error ? body.error : `successful=${body.successful}/${body.total}`}`);
    record.payments[record.payments.length - 1].attested = res.ok;
  }

  // Payer keys are deliberately not written anywhere. They are throwaways holding dust,
  // and a file of live private keys is a worse artifact than a lost few cents of gas.
  const out = `fat-path-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  log(`\nwrote ${out} (${record.payments.length} payments, ${record.payments.filter(p => p.attested).length} attested)`);
  log(`\nThe score moves on the oracle's next epoch. Check:`);
  log(`  curl -s ${ORACLE}/score/${didHash}`);
}

main().catch((e) => { console.error(`\nfailed: ${e.message}`); process.exit(1); });
