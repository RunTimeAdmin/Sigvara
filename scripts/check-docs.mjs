/**
 * Fails the build when the docs or the website disagree with the contracts.
 *
 * Why this exists. On 19 September the protocol shipped proof of control, which gave
 * registerAgent a third argument. The markdown was updated; site/docs/quickstart.html
 * was not, so the published guide told people to call a function that no longer existed
 * and the landing page still said "contracts pending deployment" three days after they
 * deployed. Nothing failed, because nothing was checking.
 *
 * Generating the HTML from the markdown was the obvious fix and the wrong one: the web
 * pages are deliberately abridged (reputation.html is 1,100 words against the model
 * doc's 2,700) and carry bespoke layout the markdown cannot express. Generating would
 * have doubled the public pages and deleted the design to fix a factual problem.
 *
 * So this checks facts instead, and checks them against src/ rather than against the
 * markdown — the markdown is just another copy that can be wrong. Prose stays free.
 *
 *   node scripts/check-docs.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ethers lives in the oracle's tree; this script has no package of its own.
const require = createRequire(join(root, 'oracle', 'index.js'));
const { ethers } = require('ethers');

const problems = [];
const fail = (what, detail) => problems.push({ what, detail });
const read = p => readFileSync(join(root, p), 'utf8');

const sources = ['SigvaraIdentity', 'SigvaraReputation', 'SigvaraStaking', 'SigvaraEpochFees', 'SVRToken']
  .map(n => ({ name: n, text: read(`src/${n}.sol`) }));

/**
 * The canonical signature of `name`, from the Solidity source.
 *
 * Handles both explicit functions and the getters Solidity generates for public
 * mappings, since the site calls several of those (`identities`, `balance`) and they
 * have selectors exactly like any other.
 */
function signatureOf(name) {
  for (const { text } of sources) {
    const fn = text.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`));
    if (fn) {
      const params = fn[1].trim();
      if (!params) return `${name}()`;
      const types = params.split(',').map(p => p.trim().split(/\s+/)[0]);
      // A struct or enum parameter needs flattening to be canonical; this script does
      // not attempt it, and says so rather than emitting a wrong selector.
      if (types.some(t => !/^(address|bool|bytes\d*|u?int\d*|string)(\[\d*\])?$/.test(t))) return null;
      return `${name}(${types.join(',')})`;
    }
    const mapping = text.match(new RegExp(`mapping\\s*\\(\\s*(\\w+)\\s*=>[^;]*?\\)\\s*public\\s+${name}\\s*;`));
    if (mapping) return `${name}(${mapping[1]})`;
    // A public scalar generates a getter too, and it takes no arguments. Without this
    // branch `minimumStake` resolves to null and the selector check skips it in
    // silence, which is indistinguishable from not checking it at all.
    const scalar = text.match(new RegExp(`\\b(?:address|bool|bytes\\d*|u?int\\d*|string)\\s+public\\s+(?:constant\\s+|immutable\\s+)?${name}\\s*[;=]`));
    if (scalar) return `${name}()`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The site's 4-byte selector table must match the deployed functions.
//    This is the check that would have caught registerAgent gaining an argument.
// ---------------------------------------------------------------------------
// ERC-20 and anything not defined in src/ is out of scope for this check.
const externalSelectors = new Set(['approve', 'allowance', 'balanceOf', 'symbol', 'decimals', 'transfer']);

// Every page that calls the contracts directly is checked. A page left off this list
// keeps working until a signature changes and then reads zeros forever, so a new page
// with its own SEL table belongs here on the day it is written.
for (const file of ['site/assets/app.js', 'site/assets/testnet.js']) {
  const selBlock = read(file).match(/(?:const|var|let) SEL = \{([\s\S]*?)\};/);
  if (!selBlock) { fail(file, 'could not find the SEL selector table'); continue; }
  for (const [, name, sel] of selBlock[1].matchAll(/(\w+)\s*:\s*"(0x[0-9a-fA-F]{8})"/g)) {
    if (externalSelectors.has(name)) continue;
    const sig = signatureOf(name);
    if (!sig) continue;              // struct params, or defined outside src/
    const want = ethers.id(sig).slice(0, 10);
    if (want.toLowerCase() !== sel.toLowerCase()) {
      fail(`${file} SEL`, `${name}: table has ${sel}, ${sig} is ${want}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The site's status labels must cover every AgentStatus the contract has.
//    A value added to the enum without a label renders as "?" to every visitor.
// ---------------------------------------------------------------------------
const enumMatch = read('src/SigvaraIdentity.sol').match(/enum AgentStatus \{([^}]*)\}/);
if (!enumMatch) fail('src/SigvaraIdentity.sol', 'could not find the AgentStatus enum');
else {
  const onchain = enumMatch[1].split(',').map(s => s.trim()).filter(Boolean).length;
  for (const file of ['site/assets/app.js', 'site/assets/testnet.js']) {
    const labels = read(file).match(/\[\s*"Active"[^\]]*\]/);
    if (!labels) { fail(file, 'could not find the status label list'); continue; }
    const shown = labels[0].split(',').length;
    if (shown !== onchain) {
      fail(`${file} status labels`, `contract has ${onchain} AgentStatus values, the page labels ${shown}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Every Arc testnet address published anywhere must match the deployment artifact.
// ---------------------------------------------------------------------------
const deployed = JSON.parse(read('deployments/5042002.json'));
const known = new Map(
  Object.entries(deployed)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('0x'))
    .map(([k, v]) => [k, v.toLowerCase()])
);

function docFiles() {
  const out = [];
  const walk = dir => {
    if (!existsSync(join(root, dir))) return;
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.(md|html|js)$/.test(e.name) && !e.name.endsWith('.min.js')) out.push(join(dir, e.name));
    }
  };
  walk('docs'); walk('site');
  out.push('README.md');
  return out;
}

// Addresses that legitimately appear and are not this deployment: the Robinhood Chain
// lineage, CounterAudit's examples, and the burn address.
const allowed = new Set([
  '0xccf2fd69c07edfbc3c215cfd31e2f20fc208a16c', '0xbb0c9c2df28af31905defea04c80372c0909f1bf',
  '0x7281cf35ae9bf56eaf5b1d0c2c8e167e50bcec75', '0xfb38fa3c085fd9d06564524855d00e098ae0c450',
  '0x9a9b6a49f3fe1c02fb1b5cb7f2911add0ce2e2bb', '0x7e44af56d14ebfd16d5d7ba4f011b5206d487d55',
  '0xbcb531b68a87f4bcc3a0394ccd2db95c52bb4e08', '0x2d657d1d166f5c7ed90bebc6808f50d07d7e70cb',
  '0x000000000000000000000000000000000000dead', '0x3600000000000000000000000000000000000000',
  '0x8004a818bfb912233c491871b3d84c89a494bd9e', '0x8004b663056a597dffe9eccc1965a193b7388713',
  '0x0000000000000000000000000000000000000000',
]);

// An address is "ours" if it shares a prefix with a deployed one but is not equal —
// that is a stale copy of a real address, which is the failure worth catching.
for (const f of docFiles()) {
  const text = read(f);
  for (const [, addr] of text.matchAll(/(0x[0-9a-fA-F]{40})/g)) {
    const low = addr.toLowerCase();
    if (allowed.has(low)) continue;
    if ([...known.values()].includes(low)) continue;
    for (const [role, real] of known) {
      if (low.slice(0, 8) === real.slice(0, 8)) {
        fail(f, `${addr} looks like a stale ${role} (deployed: ${deployed[role]})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Claims that were true once and are now false. Regression guards: each of these
//    shipped to the public site and had to be corrected by hand.
// ---------------------------------------------------------------------------
const banned = [
  ['attestations / 10', 'feeScore is measured payment volume, not a count of attestations'],
  ['floor((successful / total)', 'successScore divides by (total + 5), the shrinkage prior'],
  ['pending deployment', 'the contracts are deployed; deployments/5042002.json is committed'],
  ['maxes at 95', 'all six factors are live, so the ceiling is 100'],
  ['totalFeesUSD', 'feeScore is base units over PAYMENT_FEE_UNIT, not a USD total'],
  ['verifier.getTotalScore', 'not on the published SDK; use getReputation(did).total'],
];
for (const f of docFiles()) {
  if (f.startsWith('archive')) continue;
  const text = read(f);
  for (const [needle, why] of banned) {
    if (text.includes(needle)) fail(f, `"${needle}" — ${why}`);
  }
}

// ---------------------------------------------------------------------------
// 5. SDK methods the website tells people to call.
//
//    site/docs/quickstart.html shipped a snippet calling verifier.getTotalScore(),
//    which SigvaraVerifier did not have. Anyone following the guide got a TypeError
//    on the line the guide said would print their score. Section 1 checks contract
//    selectors and never looked at the SDK, so nothing caught it.
//
//    Checked against packages/sdk/src, which catches a typo or a removed method.
//    It does NOT catch the case that actually happened, where the source has a
//    method and the version on npm does not: the guide says `npm install` with no
//    version, so what users get is whatever was published last. That gap is a
//    release-process problem, and the banned-claims list above pins the one
//    instance rather than pretending this section covers it.
// ---------------------------------------------------------------------------
const verifierSrc = read('packages/sdk/src/verifier.ts');
const verifierMethods = new Set(
  [...verifierSrc.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][\w]*)\s*\(/gm)].map(m => m[1]),
);

for (const f of docFiles()) {
  if (!f.startsWith('site/')) continue;
  const text = read(f);
  // Snippets mark identifiers up, so the call reads
  // verifier.<span class="fn">getIdentity</span>(
  for (const m of text.matchAll(/verifier\.(?:<span class="fn">)?([a-zA-Z]\w*)/g)) {
    const method = m[1];
    if (!verifierMethods.has(method)) {
      fail(f, `verifier.${method}() is not a method on SigvaraVerifier`);
    }
  }
}

// ---------------------------------------------------------------------------
if (problems.length === 0) {
  console.log('docs check: ok');
  process.exit(0);
}
console.error(`docs check: ${problems.length} problem(s)\n`);
for (const { what, detail } of problems) console.error(`  ${what}\n    ${detail}`);
console.error('\nThese are facts the site or docs state about the contracts. Fix the text, or');
console.error('if the contract changed on purpose, update the text to match and rerun.');
process.exit(1);
