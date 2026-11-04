/**
 * Every state-changing entry point has a row in the authorisation matrix, and the row says who
 * may call it the way the code does.
 *
 *   node scripts/check-authz.mjs              check docs/authorisation-matrix.md against src/
 *   node scripts/check-authz.mjs --skeleton   print a row for every entry point, from the code
 *
 * It reads each contract in src/ that holds value or state (CONTRACTS below), collects every
 * external or public function that is neither view nor pure, adds the ones it inherits (from
 * InflowGuard and TimelockedGrants in src/, and the OpenZeppelin entry points in BASE_ENTRY),
 * and compares that set with the contract's table in the matrix. A function with no row, a row
 * for a function that does not exist, or a caller or guard that no longer matches the modifiers
 * fails the check. That is what keeps the matrix from going stale: a new handler, or a changed
 * modifier, cannot merge without its row. Any other contract in src/ (SigvaraReader today) must
 * have no state-changing entry point, or it fails too until it is added.
 *
 * Caller tokens, comma separated:
 *   role:NAME        onlyRole(NAME)
 *   owner            onlyOwner
 *   initializer      initializer
 *   reinitializer:N  reinitializer(N)
 *   checked          no access modifier; the body decides who may call (it reads msg.sender or
 *                    calls a _check function), described in the row's Requires
 *   anyone           no access modifier: any account may call, within the Requires
 *   inherited        an OpenZeppelin entry point, described in the row
 * Guard token: `inflows` for whenInflowsOpen (the guardian's pause closes it), or `-`.
 *
 * The Requires and Effect columns are prose and are not checked here; they are reviewed like any
 * other change.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = 'docs/authorisation-matrix.md';
const CONTRACTS = ['SigvaraIdentity', 'SigvaraReputation', 'SigvaraStaking', 'SigvaraOracleBond', 'SigvaraEpochFees', 'SigvaraRewardDistributor', 'SVRToken'];
// Abstract bases in src/ whose functions each heir exposes.
const SRC_BASES = { InflowGuard: 'InflowGuard', TimelockedGrants: 'TimelockedGrants' };
// OpenZeppelin bases and the state-changing entry points each adds. TimelockedGrants is
// AccessControlUpgradeable plus its own revokeRole, which then replaces OpenZeppelin's.
const BASE_ENTRY = {
  AccessControlUpgradeable: ['grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'renounceRole(bytes32,address)'],
  TimelockedGrants: ['grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'renounceRole(bytes32,address)'],
  UUPSUpgradeable: ['upgradeToAndCall(address,bytes)'],
  ERC20: ['transfer(address,uint256)', 'approve(address,uint256)', 'transferFrom(address,address,uint256)'],
  Ownable: ['transferOwnership(address)', 'renounceOwnership()'],
};

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');

// The body of the contract `name` in `text`: from its opening brace to the matching close.
function contractBody(text, name) {
  const m = new RegExp(`(?:abstract\\s+)?contract\\s+${name}\\b([^{]*)\\{`).exec(text);
  if (!m) throw new Error(`contract ${name} not found`);
  let depth = 1, i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  const bases = m[1].replace(/^\s*is\s+/, '').split(',').map((b) => b.trim().split(/[\s(]/)[0]).filter(Boolean);
  return { body: text.slice(start, i - 1), bases };
}

// Canonical parameter types: `bytes32 didHash` -> bytes32, `bytes calldata x` -> bytes.
const types = (params) => params.split(',').map((p) => p.trim()).filter(Boolean)
  .map((p) => p.split(/\s+/)[0].replace(/^(IERC20|I\w+)$/, 'address'));

// Every function in a contract body, with its header and body text.
function functions(body) {
  const out = [];
  const re = /function\s+(\w+)\s*\(([^)]*)\)([^{;]*)([{;])/g;
  let m;
  while ((m = re.exec(body))) {
    const [, name, params, rest, open] = m;
    let fnBody = '';
    if (open === '{') {
      let depth = 1, i = m.index + m[0].length;
      const s = i;
      for (; i < body.length && depth; i++) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
      }
      fnBody = body.slice(s, i - 1);
    }
    out.push({ name, params, head: rest.replace(/\s+/g, ' '), body: fnBody });
  }
  return out;
}

// Reads the caller directly: msg.sender, _msgSender(), or one of AccessControl's _check functions.
const READS_SENDER = /\bmsg\.sender\b|_msgSender\(\)|\b_check\w*\(/;

// Does `body` call the function `name`?
const calls = (body, name) => new RegExp('\\b' + name + '\\s*\\(').test(body);

// Internal functions that read the caller, directly or through another such function, like
// SigvaraIdentity._requireOperator. A call to one is a caller check in the body.
function senderHelpers(fns) {
  const helpers = new Set(fns.filter((f) => !/\b(external|public)\b/.test(f.head) && READS_SENDER.test(f.body)).map((f) => f.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fns) {
      if (helpers.has(f.name) || /\b(external|public)\b/.test(f.head)) continue;
      if ([...helpers].some((h) => calls(f.body, h))) { helpers.add(f.name); grew = true; }
    }
  }
  return helpers;
}

function entryPoints(fns, helpers) {
  const out = [];
  for (const f of fns) {
    if (!/\b(external|public)\b/.test(f.head) || /\b(view|pure)\b/.test(f.head)) continue;
    const roles = [...f.head.matchAll(/onlyRole\(\s*(\w+)\s*\)/g)].map((x) => x[1]);
    const caller = [
      ...roles.map((r) => `role:${r}`),
      ...(/\bonlyOwner\b/.test(f.head) ? ['owner'] : []),
      ...(/\binitializer\b/.test(f.head) ? ['initializer'] : []),
      ...[...f.head.matchAll(/reinitializer\(\s*(\d+)\s*\)/g)].map((x) => `reinitializer:${x[1]}`),
    ];
    const accessInBody = READS_SENDER.test(f.body) || [...helpers].some((h) => calls(f.body, h));
    out.push({
      sig: `${f.name}(${types(f.params).join(',')})`,
      caller,
      accessInBody,
      guard: /\bwhenInflowsOpen\b/.test(f.head) ? 'inflows' : '-',
    });
  }
  return out;
}

const read = (f) => strip(readFileSync(join(root, f), 'utf8'));

function contractEntries(name) {
  const { body, bases } = contractBody(read(`src/${name}.sol`), name);
  const srcBases = bases.filter((b) => SRC_BASES[b]).map((b) => functions(contractBody(read(`src/${SRC_BASES[b]}.sol`), b).body));
  const own = functions(body);
  const helpers = senderHelpers([...own, ...srcBases.flat()]);
  const bySig = new Map(entryPoints(own, helpers).map((e) => [e.sig, e]));
  for (const fns of srcBases) {
    for (const e of entryPoints(fns, helpers)) if (!bySig.has(e.sig)) bySig.set(e.sig, e);
  }
  for (const base of bases) {
    for (const sig of BASE_ENTRY[base] ?? []) {
      if (!bySig.has(sig)) bySig.set(sig, { sig, caller: [], inherited: true, guard: '-' });
    }
  }
  return [...bySig.values()];
}

// What the code says the Caller cell must contain, as a sorted token list. An entry with no
// access modifier may be `checked` or `anyone`; `checked` needs the body to decide.
function expectedCaller(e) {
  if (e.inherited) return ['inherited'];
  if (e.caller.length) return [...e.caller].sort();
  return null;
}

function parseMatrix() {
  const text = readFileSync(join(root, MATRIX), 'utf8');
  const tables = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+`?(\w+)`?\s*$/.exec(line);
    if (h) { current = CONTRACTS.includes(h[1]) ? h[1] : null; if (current) tables.set(current, []); continue; }
    if (!current || !line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0].replace(/:/g, '')) || cells[0] === 'Function') continue;
    const sig = cells[0].replace(/`/g, '');
    const tokens = (cells[1].match(/`([^`]+)`/g) ?? []).map((t) => t.replace(/`/g, '').trim());
    const guard = (cells[2].match(/`([^`]+)`/) ?? [null, '-'])[1];
    tables.get(current).push({ sig, tokens, guard });
  }
  return tables;
}

const skeleton = process.argv.includes('--skeleton');
const problems = [];
const tables = skeleton ? null : parseMatrix();
for (const name of CONTRACTS) {
  const entries = contractEntries(name).sort((a, b) => a.sig.localeCompare(b.sig));
  if (skeleton) {
    console.log(`\n## ${name}\n\n| Function | Caller | Guard | Requires | Effect |\n|---|---|---|---|---|`);
    for (const e of entries) {
      const caller = expectedCaller(e) ?? [e.accessInBody ? 'checked' : 'anyone'];
      console.log(`| \`${e.sig}\` | ${caller.map((t) => `\`${t}\``).join(', ')} | \`${e.guard}\` | | |`);
    }
    continue;
  }
  const rows = tables.get(name);
  if (!rows) { problems.push(`${name}: no table (a "## ${name}" heading with a table under it)`); continue; }
  const rowBySig = new Map();
  for (const r of rows) {
    if (rowBySig.has(r.sig)) problems.push(`${name}: ${r.sig} has two rows`);
    rowBySig.set(r.sig, r);
  }
  for (const e of entries) {
    const r = rowBySig.get(e.sig);
    if (!r) { problems.push(`${name}: ${e.sig} has no row`); continue; }
    const want = expectedCaller(e);
    const got = [...r.tokens].sort();
    if (want && got.join(',') !== want.join(',')) {
      problems.push(`${name}: ${e.sig} is called by ${want.join(', ')} in the code, the matrix says ${got.join(', ') || 'nothing'}`);
    }
    if (!want) {
      if (got.length !== 1 || !['checked', 'anyone'].includes(got[0])) {
        problems.push(`${name}: ${e.sig} has no access modifier, so its caller is \`checked\` or \`anyone\`, not ${got.join(', ') || 'nothing'}`);
      } else if (got[0] === 'checked' && !e.accessInBody) {
        problems.push(`${name}: ${e.sig} is marked \`checked\`, but its body neither reads msg.sender nor calls a _check function`);
      }
    }
    if (r.guard !== e.guard) problems.push(`${name}: ${e.sig} guard is \`${e.guard}\` in the code, the matrix says \`${r.guard}\``);
  }
  for (const r of rows) {
    if (!entries.some((e) => e.sig === r.sig)) problems.push(`${name}: the matrix has a row for ${r.sig}, which is not a state-changing entry point`);
  }
}

if (skeleton) process.exit(0);

// A contract added to src/ is covered too: if it can change state, it needs a table.
for (const file of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.sol'))) {
  const text = read(`src/${file}`);
  for (const [, name] of text.matchAll(/^contract\s+(\w+)/gm)) {
    if (CONTRACTS.includes(name)) continue;
    const n = entryPoints(functions(contractBody(text, name).body), new Set()).length;
    if (n) problems.push(`${name} (src/${file}) has ${n} state-changing entry point(s) and no table: add it to CONTRACTS and the matrix`);
  }
}

if (problems.length) {
  console.error(`authorisation matrix: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`authorisation matrix: every entry point of ${CONTRACTS.length} contracts has a row that matches the code`);
