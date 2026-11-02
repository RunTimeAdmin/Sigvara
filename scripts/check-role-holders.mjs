/**
 * Who holds every role on the mainnet deployment, from the chain's own history.
 *
 * AccessControl is not enumerable. hasRole answers only for an address you already
 * suspect, so a grant nobody expected is invisible to it. This replays every RoleGranted
 * and RoleRevoked event from the deploy block for the proxies and the timelock, and
 * fails unless each role is held by exactly the expected addresses and no role exists
 * that is not on the list.
 *
 *   SAFE=0x.. TIMELOCK=0x.. COMMITTEE=0x.. ORACLE=0x.. GUARDIAN=0x.. node scripts/check-role-holders.mjs
 *
 * Run it twice. The step that hands authority over cannot be undone (script/SplitAuthority.s.sol, the
 * last phase: the deployer renounces UPGRADER_ROLE), and a holder nobody expected is cheap to remove
 * before it and slow to remove after, because the upgrader role then answers only to the timelock. So:
 *
 *   1. After the Safe has removed the deployer's admin and before the last phase, through
 *      scripts/check-before-renounce.mjs, which runs this with BEFORE_RENOUNCE=1 and writes the report
 *      the renounce takes. Run alone, it writes nothing the renounce accepts. The deployer is then expected to hold UPGRADER_ROLE beside the timelock, and
 *      nothing else about the table changes. A second upgrader, a missing grant or an admin that is
 *      not the Safe alone stops it. The script's own checks read the contracts it is shown; this reads
 *      the history, which is the only way to see a holder it was not looking for.
 *   2. After the last phase, without it. Now the timelock alone holds UPGRADER_ROLE.
 *
 * The proxies and the deploy block come from deployments/5042.json: four, and a fifth
 * (epochFees) only if the artifact has one, since the epoch-fee module is left out of the
 * mainnet launch (docs/adr/0005). The holders come from the environment, so a wrong artifact
 * cannot vouch for itself.
 *
 * CHAIN_ID (default 5042) picks the artifact and the chain, for a rehearsal; RPC_URL then names the endpoint.
 * RPC_URL overrides the default endpoint. The public endpoint caps eth_getLogs at 10,000
 * blocks and throttles bursts, so the scan is chunked and paced (PACE_MS, default 500).
 * A provider with a larger range makes a late run faster.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

// Mainnet unless told otherwise, for a rehearsal (scripts/check-before-renounce.mjs passes both on).
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const RPC = process.env.RPC_URL || (CHAIN_ID === 5042 ? 'https://rpc.mainnet.arc.io' : null);
if (!RPC) {
  console.error(`set RPC_URL for chain ${CHAIN_ID}`);
  process.exit(1);
}
const RANGE = Number(process.env.MAX_RANGE || 10000);
const PACE_MS = Number(process.env.PACE_MS || 500);

const artifact = JSON.parse(readFileSync(join(root, 'deployments', `${CHAIN_ID}.json`), 'utf8'));

let failed = false;
const ok = msg => console.log(`ok    ${msg}`);
const fail = msg => { console.log(`FAIL  ${msg}`); failed = true; };

const need = name => {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) { fail(`${name} is not set to an address`); return null; }
  return v.toLowerCase();
};
// Before the deployer drops UPGRADER_ROLE it is still one of its holders, by design.
const BEFORE_RENOUNCE = process.env.BEFORE_RENOUNCE === '1';
const SAFE = need('SAFE');
const TIMELOCK = need('TIMELOCK');
const COMMITTEE = need('COMMITTEE');
const ORACLE = need('ORACLE');
const GUARDIAN = need('GUARDIAN');
for (const k of ['identity', 'reputation', 'staking', 'oracleBond']) {
  if (!artifact[k]) fail(`deployments/${CHAIN_ID}.json has no ${k}`);
}
if (!Number.isInteger(artifact.deployBlock)) {
  fail(`deployments/${CHAIN_ID}.json has no deployBlock (script/Deploy.s.sol writes it; an older artifact needs the block of the first deployment transaction, or an earlier one)`);
}
if (BEFORE_RENOUNCE && !ethers.isAddress(artifact.deployer)) fail(`deployments/${CHAIN_ID}.json has no deployer`);
if (failed) process.exit(1);
console.log(BEFORE_RENOUNCE
  ? 'mode  before the renounce: the deployer is expected to still hold UPGRADER_ROLE, beside the timelock'
  : 'mode  after the handover: the timelock alone is expected to hold UPGRADER_ROLE');
// Checked when the artifact has it, said aloud when it does not, so a missing entry cannot pass
// for a clean result.
if (!artifact.epochFees) {
  console.log(`note  deployments/${CHAIN_ID}.json has no epochFees: the epoch-fee module is left out of launch (docs/adr/0005), so it is not checked`);
}

const ZERO_ADDR = ethers.ZeroAddress.toLowerCase();
const ADMIN = ethers.ZeroHash;
const R = n => ethers.id(n);
const STAKING = artifact.staking.toLowerCase();
const UPGRADERS = BEFORE_RENOUNCE ? [TIMELOCK, artifact.deployer.toLowerCase()] : [TIMELOCK];

// role name -> the only addresses that may hold it
const expected = {
  identity: {
    address: artifact.identity,
    roles: {
      DEFAULT_ADMIN_ROLE: [SAFE], UPGRADER_ROLE: UPGRADERS, STAKING_CORE_ROLE: [STAKING],
      GUARDIAN_ROLE: [GUARDIAN],
    },
  },
  reputation: {
    address: artifact.reputation,
    roles: {
      DEFAULT_ADMIN_ROLE: [SAFE], UPGRADER_ROLE: UPGRADERS, STAKING_CORE_ROLE: [STAKING],
      ORACLE_ROLE: [ORACLE], SLASHING_COMMITTEE_ROLE: [COMMITTEE], GUARDIAN_ROLE: [GUARDIAN],
    },
  },
  staking: {
    address: artifact.staking,
    roles: {
      DEFAULT_ADMIN_ROLE: [SAFE], UPGRADER_ROLE: UPGRADERS, SLASHING_COMMITTEE_ROLE: [COMMITTEE],
      GUARDIAN_ROLE: [GUARDIAN],
    },
  },
  oracleBond: {
    address: artifact.oracleBond,
    roles: {
      DEFAULT_ADMIN_ROLE: [SAFE], UPGRADER_ROLE: UPGRADERS, SLASHER_ROLE: [COMMITTEE],
      GUARDIAN_ROLE: [GUARDIAN],
    },
  },
  ...(artifact.epochFees && {
    epochFees: {
      address: artifact.epochFees,
      roles: { DEFAULT_ADMIN_ROLE: [SAFE], UPGRADER_ROLE: UPGRADERS, ORACLE_ROLE: [ORACLE] },
    },
  }),
  timelock: {
    address: TIMELOCK,
    roles: {
      DEFAULT_ADMIN_ROLE: [TIMELOCK], PROPOSER_ROLE: [SAFE], CANCELLER_ROLE: [SAFE], EXECUTOR_ROLE: [ZERO_ADDR],
    },
  },
};

const provider = new ethers.JsonRpcProvider(RPC);
const reported = Number((await provider.getNetwork()).chainId);
if (reported !== CHAIN_ID) {
  console.error(`${RPC} reports chain ${reported}, but this check is for chain ${CHAIN_ID}`);
  process.exit(1);
}

const GRANTED = ethers.id('RoleGranted(bytes32,address,address)');
const REVOKED = ethers.id('RoleRevoked(bytes32,address,address)');
const head = await provider.getBlockNumber();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function holdersOf(address) {
  const members = new Map(); // role hash -> Set of lowercase addresses
  for (let from = artifact.deployBlock; from <= head; from += RANGE) {
    const to = Math.min(from + RANGE - 1, head);
    const logs = await provider.getLogs({ address, fromBlock: from, toBlock: to, topics: [[GRANTED, REVOKED]] });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    for (const l of logs) {
      const role = l.topics[1];
      const account = ethers.getAddress('0x' + l.topics[2].slice(26)).toLowerCase();
      if (!members.has(role)) members.set(role, new Set());
      if (l.topics[0] === GRANTED) members.get(role).add(account); else members.get(role).delete(account);
    }
    if (to < head) await sleep(PACE_MS);
  }
  return members;
}

const hashOf = {
  DEFAULT_ADMIN_ROLE: ADMIN, UPGRADER_ROLE: R('UPGRADER_ROLE'), STAKING_CORE_ROLE: R('STAKING_CORE_ROLE'),
  ORACLE_ROLE: R('ORACLE_ROLE'), SLASHING_COMMITTEE_ROLE: R('SLASHING_COMMITTEE_ROLE'),
  SLASHER_ROLE: R('SLASHER_ROLE'), PROPOSER_ROLE: R('PROPOSER_ROLE'), CANCELLER_ROLE: R('CANCELLER_ROLE'),
  EXECUTOR_ROLE: R('EXECUTOR_ROLE'), GUARDIAN_ROLE: R('GUARDIAN_ROLE'),
};
const nameOf = Object.fromEntries(Object.entries(hashOf).map(([n, h]) => [h, n]));

for (const [name, spec] of Object.entries(expected)) {
  const found = await holdersOf(spec.address);
  for (const [roleName, want] of Object.entries(spec.roles)) {
    const got = [...(found.get(hashOf[roleName]) ?? [])].sort();
    const w = [...want].sort();
    if (got.length === w.length && got.every((a, i) => a === w[i])) ok(`${name}: ${roleName} is held by exactly ${w.join(', ')}`);
    else fail(`${name}: ${roleName} is held by [${got.join(', ')}], expected [${w.join(', ')}]`);
  }
  // A role this contract is not supposed to have, held by anyone, is as much a finding as a
  // missing one.
  const wanted = new Set(Object.keys(spec.roles).map(n => hashOf[n]));
  for (const [role, set] of found) {
    if (set.size > 0 && !wanted.has(role)) {
      fail(`${name}: unexpected role ${nameOf[role] ?? role} held by [${[...set].join(', ')}]`);
    }
  }
}

console.log(failed ? 'role holders: STOP, something above failed' : 'role holders: all checks passed');
process.exit(failed ? 1 : 0);
