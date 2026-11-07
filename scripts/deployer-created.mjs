/**
 * The proxies a deployer created, from its own nonce. Used by scripts/check-before-renounce.mjs.
 *
 * The handover works from the deployment artifact: it moves authority on the contracts the artifact names, and on
 * nothing else. A proxy the artifact leaves out, such as an epoch-fee module deployed and not recorded or a first try
 * that was abandoned, keeps the deployer as its admin and upgrader after a handover that reports success.
 *
 * A contract an account creates sits at an address worked out from the account and its nonce, so every one can be
 * listed without trusting any record of them. This finds what the deployer created directly. A contract made by a
 * factory it called is at an address only that factory's history shows, and script/Deploy.s.sol uses none.
 *
 * `assessUnrecordedProxies` is pure, so `node scripts/check-before-renounce.mjs --self-test` runs it on made-up chains.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

// ERC-1967's slot for the implementation: set on a proxy, and empty on anything else the deployer made.
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd';
const ROLES = new ethers.Interface(['function hasRole(bytes32,address) view returns (bool)']);
const ROLES_TO_ASK = [['DEFAULT_ADMIN_ROLE', ethers.ZeroHash], ['UPGRADER_ROLE', ethers.id('UPGRADER_ROLE')]];
const NAMED_IN_ARTIFACT = ['identity', 'reputation', 'staking', 'oracleBond', 'epochFees'];
// Reads between pauses. A deployer's nonce is small, and these go to the same public endpoint as the log reads.
const READS_PER_PAUSE = 20;

/** The proxies the artifact names, lowercased. Anything else the deployer created is what the check is for. */
export function recordedProxies(artifact) {
  return new Set(NAMED_IN_ARTIFACT.map((name) => artifact[name]).filter(Boolean).map((a) => a.toLowerCase()));
}

/** REVIEWED_UNRECORDED_PROXIES, lowercased and sorted. Throws on anything that is not an address. */
export function reviewedProxiesFrom(raw) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    if (!ethers.isAddress(entry)) throw new Error(`REVIEWED_UNRECORDED_PROXIES: ${entry} is not an address`);
  }
  return list.map((a) => a.toLowerCase()).sort();
}

/**
 * Every proxy `deployer` created by its first `nonce` transactions, as it stood at block `at`.
 *
 * @returns {Promise<Array<{ address: string, nonce: number, deployerHolds: string[] }>>} in nonce order
 */
export async function proxiesCreatedBy(provider, deployer, nonce, at, { paceMs = 500 } = {}) {
  const out = [];
  for (let n = 0; n < nonce; n += 1) {
    if (n > 0 && n % READS_PER_PAUSE === 0 && paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    const address = ethers.getCreateAddress({ from: deployer, nonce: n }).toLowerCase();
    if ((await provider.getCode(address, at)) === '0x') continue;
    const implementation = await provider.getStorage(address, IMPLEMENTATION_SLOT, at);
    if (BigInt(implementation) === 0n) continue;
    const deployerHolds = [];
    for (const [name, role] of ROLES_TO_ASK) {
      try {
        const answer = await provider.call({ to: address, data: ROLES.encodeFunctionData('hasRole', [role, deployer]), blockTag: at });
        if (ROLES.decodeFunctionResult('hasRole', answer)[0]) deployerHolds.push(name);
      } catch {
        // Not AccessControl, so nothing to say about it here. It is still a proxy nobody accounted for.
      }
    }
    out.push({ address, nonce: n, deployerHolds });
  }
  return out;
}

/**
 * Which proxies the artifact leaves out and nobody has reviewed, and any review that names something else. Pure.
 *
 * @param {{ proxies: object[], recorded: Set<string>, reviewed: string[] }} state
 * @returns {{ problems: string[], unrecorded: object[] }}
 */
export function assessUnrecordedProxies({ proxies, recorded, reviewed }) {
  const problems = [];
  const unrecorded = proxies.filter((p) => !recorded.has(p.address));
  const listed = new Set(reviewed);
  for (const p of unrecorded) {
    if (listed.has(p.address)) continue;
    const holds = p.deployerHolds.length ? `the deployer holds ${p.deployerHolds.join(' and ')} on it` : 'the deployer holds neither admin nor upgrader on it';
    problems.push(`${p.address} (deployer nonce ${p.nonce}) is a proxy the artifact does not name, so no phase of the handover touches it, and ${holds}. Decide what happens to it and list it in REVIEWED_UNRECORDED_PROXIES`);
  }
  const unrecordedAddresses = new Set(unrecorded.map((p) => p.address));
  for (const address of reviewed) {
    if (!unrecordedAddresses.has(address)) problems.push(`${address} is in REVIEWED_UNRECORDED_PROXIES and is not an unrecorded proxy this deployer created`);
  }
  return { problems, unrecorded };
}
