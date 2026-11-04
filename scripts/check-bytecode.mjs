/**
 * Does each deployed contract match a build of this repository?
 *
 *   forge build && node scripts/check-bytecode.mjs
 *
 * For every proxy in deployments/<chain>.json, the implementation it runs, the SVR token, the reader
 * and the proxies themselves, it reads the runtime code from the chain and compares it with the artifact
 * forge built from this checkout, byte for byte, after blanking the immutables (forge's
 * immutableReferences say where they are; a UUPS implementation stores its own address in one).
 * A match means the deployed code is exactly what this checkout compiles to, down to the source
 * metadata hash, so anyone can rebuild it and get the same bytes.
 *
 * The deployment file names a commit whose build reproduces each contract (`reproducedAt`, on an
 * implementation's entry or under `bytecode` for the rest; the commit is tagged). When this
 * checkout's contract sources differ from that commit, a mismatch is expected, because main has
 * moved on since the deploy; it is reported as such and does not fail. Check out the tag to
 * reproduce that build. Build in an ordinary checkout: a lib/ that is a symlink or junction changes
 * the source paths solc records, and with them the metadata hash.
 *
 * Arc testnet unless told otherwise. CHAIN_ID and RPC_URL work as in record-implementations.mjs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042002);
const RPCS = { 5042002: 'https://rpc.testnet.arc.io' };
const RPC = process.env.RPC_URL || RPCS[CHAIN_ID];
if (!RPC) { console.error(`no RPC for chain ${CHAIN_ID}; set RPC_URL`); process.exit(2); }

// Proxy name in the deployment file -> the contract behind it.
const IMPLEMENTATIONS = {
  identity: 'SigvaraIdentity',
  reputation: 'SigvaraReputation',
  staking: 'SigvaraStaking',
  oracleBond: 'SigvaraOracleBond',
};

const deployed = JSON.parse(readFileSync(join(root, `deployments/${CHAIN_ID}.json`), 'utf8'));

function artifact(contract, file = `${contract}.sol`) {
  const path = join(root, 'out', file, `${contract}.json`);
  if (!existsSync(path)) throw new Error(`${path} is missing; run forge build first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function codeAt(address) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  });
  const j = await res.json();
  if (typeof j.result !== 'string') throw new Error(j.error?.message ?? 'no code returned');
  return j.result.slice(2).toLowerCase();
}

// Blank every immutable's bytes, which the built artifact leaves as zeros.
function blankImmutables(hex, refs) {
  const bytes = Buffer.from(hex, 'hex');
  for (const list of Object.values(refs ?? {})) for (const { start, length } of list) bytes.fill(0, start, start + length);
  return bytes.toString('hex');
}

// The code without solc's trailing CBOR metadata, whose length is in the last two bytes.
function withoutMetadata(hex) {
  const len = parseInt(hex.slice(-4), 16);
  return hex.slice(0, hex.length - (len + 2) * 2);
}

// Has any contract source changed between `commit` and this checkout, committed or not?
function sourcesChangedSince(commit) {
  try {
    execFileSync('git', ['diff', '--quiet', commit, '--', 'src', 'foundry.toml', 'scripts/fetch-deps.sh'], { cwd: root });
    return false;
  } catch {
    return true;
  }
}

const rows = [];
async function compare(label, address, contract, file, reproducedAt = deployed.bytecode?.reproducedAt) {
  const a = artifact(contract, file);
  const local = a.deployedBytecode.object.slice(2).toLowerCase();
  const chain = blankImmutables(await codeAt(address), a.deployedBytecode.immutableReferences);
  let result;
  if (!chain.length) result = { ok: false, text: 'no code at this address' };
  else if (chain === local) result = { ok: true, text: `matches this checkout's build of ${contract}` };
  else if (withoutMetadata(chain) === withoutMetadata(local)) result = { ok: false, text: `same code as ${contract}, different source metadata` };
  else result = { ok: false, text: `differs from this checkout's build of ${contract}` };
  if (!result.ok && reproducedAt && sourcesChangedSince(reproducedAt)) {
    result = { ok: true, expected: true, text: `${result.text}; expected, since the sources changed after ${reproducedAt}, whose build reproduces it` };
  }
  rows.push({ label, address, ...result });
}

for (const [name, contract] of Object.entries(IMPLEMENTATIONS)) {
  const entry = deployed.implementations?.[name];
  if (!deployed[name] || !entry?.current) continue;
  await compare(`${name} implementation`, entry.current, contract, undefined, entry.reproducedAt);
  await compare(`${name} proxy`, deployed[name], 'ERC1967Proxy');
}
if (deployed.svrToken) await compare('svrToken', deployed.svrToken, 'SVRToken');
if (deployed.reader) await compare('reader', deployed.reader, 'SigvaraReader');

for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(26)} ${r.address}  ${r.text}`);
const failed = rows.filter((r) => !r.ok).length;
const expected = rows.filter((r) => r.expected).length;
if (failed) console.log(`\nbytecode: ${failed} of ${rows.length} do not match`);
else if (expected) console.log(`\nbytecode: ${rows.length - expected} match, ${expected} ${expected === 1 ? 'differs' : 'differ'} only because the sources changed since the recorded build`);
else console.log(`\nbytecode: all ${rows.length} match`);
process.exit(failed ? 1 : 0);
