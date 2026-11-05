#!/usr/bin/env node
/**
 * Looks at the live deployment from outside, the way a visitor and an attacker would.
 *
 *   node scripts/check-live.mjs site       every deployed file equals what main says
 *   node scripts/check-live.mjs services   oracle, checker and event index answer, certificates are not near expiry
 *   node scripts/check-live.mjs outcomes   oracle and checker hold the same payer-signed outcomes
 *   node scripts/check-live.mjs            all three
 *
 * `outcomes` reads every page of GET /outcomes from both operators and matches them by didHash,
 * txHash and payer. It fails when the two hold different outcomes for one payment leg, or when one
 * holds an outcome the other does not and took it more than OUTCOMES_LAG_HOURS ago (default 2: the
 * other imports at its next hourly epoch, so two hours is a missed import). A younger one is listed
 * as in flight. The workflow does not run it; docs/operations-runbook.md says when to.
 *
 * Why it exists. The site is uploaded by hand and nothing signs or verifies what reaches
 * users, yet `assets/app.js` decides what a wallet is asked to sign. If a hosting account,
 * a neighbouring site or the CDN changes a file, nobody would notice until a user did.
 * This compares the bytes users receive with the bytes in git, so a change that is not a
 * reviewed commit shows up at the next scheduled run (every 5 to 7 hours in practice). It also fires when a merged site change has not
 * been uploaded yet, which the deploy notes say has been forgotten more than once.
 *
 * It runs from GitHub Actions on a schedule (.github/workflows/live-checks.yml), a place
 * that shares no account, host or credential with the things it watches. A failed run
 * emails the repository owner, which makes it a second alert path beside the Discord
 * watcher: it does not depend on the three servers being up.
 *
 * Reads only. Every request is a GET to a public URL, or a read of the chain over the public RPC.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const SITE = process.env.SITE_BASE || 'https://sigvara.xyz';
const ORACLE = process.env.ORACLE_BASE || 'https://oracle.sigvara.xyz';
const CHECKER = process.env.CHECKER_BASE || 'https://checker.sigvara.xyz';
const INDEX = process.env.INDEX_BASE || 'https://index.sigvara.xyz';
const EPOCH_STALE_MS = 3 * 3600 * 1000;       // the oracle runs hourly; three hours is a missed run
const CERT_MIN_DAYS = 14;
const RPC = process.env.RPC_URL || 'https://rpc.testnet.arc.io';
// topic0 of SlashInitiated and the selector of getSlashProposal, as site/assets/explorer.js has them,
// where scripts/check-docs.mjs checks each one against src/.
export const SLASH_INITIATED = '0x68a6dcb0be51611092b43c97ef36088f9f1c0905c37d8170b379a590d8a50f01';
export const GET_SLASH_PROPOSAL = '0xc984f6f8';
// A keeper executes a slash within a run of its deadline and the backup within an hour and a bit.
// Six hours past it, both have failed, with most of the fortnight left to do something about it.
const SLASH_OVERDUE_SECONDS = 6 * 3600;
// Slashes meant to sit past their deadline. The drill leaves agent C to lapse on 24 November 2026
// (docs/slash-drill.md); once it is expired it is not Pending, and this entry does nothing.
const SLASHES_HELD = new Set(['0x30b95fc4473e5ea0f187d4955ab24bcfebd7a739a0a93c1beafd5d6445f1d93a']);
const OUTCOMES_LAG_HOURS = process.env.OUTCOMES_LAG_HOURS ? Number(process.env.OUTCOMES_LAG_HOURS) : 2;
// Repo-facing files under site/ that are never published, and the one file the host does not serve.
const NOT_SERVED = new Set(['SECURITY.md', 'SECURITY_DEPLOYMENT_CHECKLIST.md', '.htaccess']);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const problems = [];
const fail = (msg) => problems.push(msg);

async function get(url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...opts });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

/** The URL a visitor uses for a tracked file. The host serves /name for name.html. */
function urlPathFor(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('.html')) return '/' + rel.slice(0, -5);
  return '/' + rel;
}

function trackedSiteFiles() {
  const out = execFileSync('git', ['ls-files', '-z', 'site'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean)
    .map((p) => p.replace(/^site\//, ''))
    .filter((rel) => !NOT_SERVED.has(rel))
    .sort();
}

/**
 * Header values the policy file promises, parsed from the file that is deployed: the site-wide
 * ones, and for each <FilesMatch> block its pattern and the headers it sets on those files only.
 */
function promisedHeaders() {
  const text = readFileSync('site/.htaccess', 'utf8');
  const siteWide = new Map();
  const scoped = [];
  let scope = null;
  for (const line of text.split('\n')) {
    const open = /^\s*<FilesMatch\s+"([^"]*)"\s*>\s*$/i.exec(line);
    if (open) { scope = { pattern: new RegExp(open[1]), headers: new Map() }; scoped.push(scope); continue; }
    if (/^\s*<\/FilesMatch>\s*$/i.test(line)) { scope = null; continue; }
    const m = /^\s*Header\s+always\s+set\s+(\S+)\s+"([^"]*)"\s*$/i.exec(line);
    if (m) (scope ? scope.headers : siteWide).set(m[1].toLowerCase(), m[2]);
  }
  return { siteWide, scoped };
}

async function checkSite() {
  const files = trackedSiteFiles();
  let checked = 0;
  // Twice per file: the plain URL is what users get (it may be served from the edge cache),
  // the cache-busting one is what the host serves now. A difference in either is a finding.
  for (const rel of files) {
    const want = sha(readFileSync('site/' + rel));
    const path = urlPathFor(rel);
    for (const [label, query] of [['as served', ''], ['fresh from the host', `?cb=${Date.now()}${Math.floor(Math.random() * 1e6)}`]]) {
      try {
        const { res, body } = await get(SITE + path + query);
        if (res.status !== 200) fail(`${path} (${label}): status ${res.status}, expected 200`);
        else if (sha(body) !== want) fail(`${path} (${label}): content differs from main (live ${sha(body).slice(0, 12)}, main ${want.slice(0, 12)}, ${body.length} bytes live)`);
      } catch (e) {
        fail(`${path} (${label}): ${e.message}`);
      }
    }
    checked++;
  }

  // The headers are defined by .htaccess, which is not served, so compare what arrives with
  // what the file promises, on the pages that matter most. A file a <FilesMatch> block names
  // gets the site-wide headers with the block's on top; a page it does not name must not carry
  // the headers only the block sets.
  const { siteWide, scoped } = promisedHeaders();
  const onlyScoped = new Set(scoped.flatMap((s) => [...s.headers.keys()]).filter((name) => !siteWide.has(name)));
  const targets = ['/', '/app', '/assets/app.js'].map((path) => ({ path, promised: siteWide, absent: onlyScoped }));
  for (const { pattern, headers } of scoped) {
    for (const rel of files.filter((f) => pattern.test(f.split('/').pop()))) {
      targets.push({ path: urlPathFor(rel), promised: new Map([...siteWide, ...headers]), absent: new Set() });
    }
  }
  for (const { path, promised, absent } of targets) {
    try {
      const { res } = await get(SITE + path + `?cb=${Date.now()}`);
      for (const [name, value] of promised) {
        const got = res.headers.get(name);
        if (got !== value) fail(`${path}: header ${name} is ${got === null ? 'missing' : `"${got.slice(0, 80)}"`}, .htaccess promises "${value.slice(0, 80)}"`);
      }
      for (const name of absent) {
        if (res.headers.get(name) !== null) fail(`${path}: header ${name} is set, but .htaccess sets it only on the files a <FilesMatch> block names`);
      }
    } catch (e) {
      fail(`${path} headers: ${e.message}`);
    }
  }

  // A missing path must get the site's own page with the same headers, not the host's default
  // page (which loads third-party scripts and carries no policy).
  try {
    const { res, body } = await get(SITE + `/this-path-does-not-exist-${Date.now()}`);
    const csp = res.headers.get('content-security-policy');
    if (res.status !== 404) fail(`missing path: status ${res.status}, expected 404`);
    if (!csp || !csp.includes("script-src 'self'")) fail('missing path: the response does not carry the site Content-Security-Policy');
    if (/googletagmanager|google-analytics|doubleclick|bootstrapcdn/i.test(body.toString('utf8'))) fail('missing path: the response loads third-party scripts');
  } catch (e) {
    fail(`missing path: ${e.message}`);
  }
  console.log(`site: ${checked} deployed files compared with main, headers and 404 page checked`);
}

function certDaysLeft(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const cert = s.getPeerCertificate();
      s.destroy();
      resolve((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}

async function checkServices() {
  for (const [name, base] of [['oracle', ORACLE], ['checker', CHECKER]]) {
    try {
      const { res, body } = await get(base + '/health');
      const j = JSON.parse(body.toString('utf8'));
      if (res.status !== 200 || j.ok !== true) fail(`${name}: /health status ${res.status}, ok=${j.ok}`);
      const since = Number(j.timeSinceLastEpochMs);
      if (Number.isFinite(since) && since > EPOCH_STALE_MS) fail(`${name}: no completed epoch for ${Math.round(since / 60000)} minutes`);
      if (j.storeWritable === false || j.statePersisted === false) fail(`${name}: state is not being saved`);
    } catch (e) {
      fail(`${name}: /health unreachable or unreadable (${e.message})`);
    }
  }
  // The event index the explorer pages read their history from (docs/event-index.md). Its /health
  // fails once it has not polled for a few minutes or is more than about half an hour behind.
  try {
    const { res, body } = await get(INDEX + '/health');
    const j = JSON.parse(body.toString('utf8'));
    if (res.status !== 200 || j.ok !== true) {
      fail(`index: /health status ${res.status}, ok=${j.ok}, ${j.behind ?? '?'} blocks behind${j.lastError ? `, last error: ${j.lastError}` : ''}`);
    }
    // Said before it fills: a full index stops reading on, and nothing else watches its size.
    if (j.maxLogs && j.logs > j.maxLogs * 0.8) fail(`index: holds ${j.logs} of at most ${j.maxLogs} logs; raise INDEX_MAX_LOGS and its mem_limit together`);
  } catch (e) {
    fail(`index: /health unreachable or unreadable (${e.message})`);
  }
  try {
    const { res, body } = await get(CHECKER + '/divergence');
    const j = JSON.parse(body.toString('utf8'));
    if (res.status !== 200) fail(`checker: /divergence status ${res.status}`);
    else if (j.mode !== 'checker') fail(`checker: /divergence reports mode "${j.mode}"`);
    else if (j.seesProposals === false) fail('checker: its epoch is too long to see proposals before they expire');
    else if (Array.isArray(j.divergences) && j.divergences.length > 0) {
      // A record matters while its proposal can still be rejected. Records cannot be retracted
      // and stay listed for 30 days, so counting all of them kept this red for a month after one
      // disagreement that was already settled (docs/divergence-log.md, 1 November 2026). The
      // watcher reads the deadline the contract fixed (oracle/watcher-policy.js); this check makes
      // GET requests only, so it uses proposedAt plus the window the checker reports. The two
      // agree unless the window changed while the proposal was pending. A record without a
      // readable proposedAt, or a response without a readable window, counts as open.
      const windowSec = Number(j.challengeWindowHours) * 3600;
      const nowSec = Date.now() / 1000;
      const open = j.divergences.filter((d) => !(Number(d.proposedAt) + windowSec < nowSec));
      if (open.length > 0) fail(`checker: ${open.length} divergence(s) from the primary on proposals that may still be rejected, see ${CHECKER}/divergence`);
      else console.log(`checker: ${j.divergences.length} divergence record(s) past their challenge window, so settled; see ${CHECKER}/divergence and docs/divergence-log.md`);
    }
  } catch (e) {
    fail(`checker: /divergence unreachable or unreadable (${e.message})`);
  }
  await checkSlashes();
  for (const host of new URL(SITE).host === 'sigvara.xyz' ? ['sigvara.xyz', 'oracle.sigvara.xyz', 'checker.sigvara.xyz', 'index.sigvara.xyz'] : []) {
    try {
      const days = await certDaysLeft(host);
      if (days < CERT_MIN_DAYS) fail(`${host}: certificate expires in ${days.toFixed(1)} days`);
    } catch (e) {
      fail(`${host}: certificate check failed (${e.message})`);
    }
  }
  console.log('services: oracle, checker and event index health, divergence list and certificate expiry checked');
  await checkWallets();
}

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/**
 * The wallets under their floors, as { name, address, usdc, minUsdc }. Pure, so a test can hold it to
 * them. `wallets` is as in deployments/5042002.json, and `balances` is by name, in wei: on Arc, gas is USDC.
 */
export function lowWallets(wallets, balances) {
  return Object.entries(wallets)
    .filter(([name, w]) => balances[name] < BigInt(w.minUsdc) * 10n ** 18n)
    .map(([name, w]) => ({ name, address: w.address, minUsdc: w.minUsdc, usdc: usdcOf(balances[name]) }));
}

const usdcOf = (wei) => (Number(wei / 10n ** 16n) / 100).toFixed(2);

// A wallet with no gas stops proposing, finalizing or posting, and nothing else would say why until
// scores went stale. This says so with time to spare, from a place that shares nothing with them.
async function checkWallets() {
  try {
    const { wallets } = JSON.parse(readFileSync('deployments/5042002.json', 'utf8'));
    const balances = {};
    for (const [name, w] of Object.entries(wallets)) {
      balances[name] = BigInt(await rpcCall('eth_getBalance', [w.address, 'latest']));
    }
    for (const w of lowWallets(wallets, balances)) {
      fail(`wallets: ${w.name} (${w.address}) has ${w.usdc} USDC, under its floor of ${w.minUsdc}. See the runbook, "Gas"`);
    }
    console.log(`wallets: ${Object.keys(wallets).map((n) => `${n} ${usdcOf(balances[n])} USDC`).join(', ')}`);
  } catch (e) {
    fail(`wallets: could not read them (${e.message})`);
  }
}

/**
 * Pending slashes past their deadline that nobody has executed, as { didHash, hoursLate, deadline }.
 * Pure, so a test can hold it to the keeper's rules. `proposals` is what getSlashProposal returned.
 */
export function overdueSlashes(proposals, nowSec, { overdueSeconds = SLASH_OVERDUE_SECONDS, held = SLASHES_HELD } = {}) {
  return proposals
    .filter((p) => p.state === 1 && !held.has(p.didHash) && nowSec > p.challengeDeadline + overdueSeconds)
    .map((p) => ({ didHash: p.didHash, deadline: p.challengeDeadline, hoursLate: Math.floor((nowSec - p.challengeDeadline) / 3600) }));
}

/** The words of an ABI-encoded getSlashProposal answer that matter here. */
export function decodeSlashProposal(didHash, hex) {
  const word = (i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  // Word 0 is the offset to the struct. Then didHash, reporter, victim, initiatedAt, state, the offset
  // of evidenceHash, challengeDeadline, disputedAt.
  return { didHash, state: Number(BigInt('0x' + word(5))), challengeDeadline: Number(BigInt('0x' + word(7))) };
}

// A slash the keepers should have settled, whatever state the keepers think they are in. This
// watches the outcome from a place that shares nothing with them, so it is what notices when both
// are down, misconfigured or out of gas.
async function checkSlashes() {
  try {
    const deployed = JSON.parse(readFileSync('deployments/5042002.json', 'utf8'));
    const { res, body } = await get(`${INDEX}/events?address=${deployed.staking}&topic0=${SLASH_INITIATED}`);
    if (res.status !== 200) throw new Error(`the event index answered ${res.status}`);
    const filed = [...new Set(JSON.parse(body.toString('utf8')).logs.map((l) => l.topics[1].toLowerCase()))];
    const proposals = [];
    for (const didHash of filed) {
      proposals.push(decodeSlashProposal(didHash, await rpcCall('eth_call', [{ to: deployed.staking, data: GET_SLASH_PROPOSAL + didHash.slice(2) }, 'latest'])));
    }
    const block = await rpcCall('eth_getBlockByNumber', ['latest', false]);
    for (const o of overdueSlashes(proposals, Number(BigInt(block.timestamp)))) {
      fail(`slashes: ${o.didHash} is ${o.hoursLate} hours past its deadline and nobody has executed it. See the runbook, section 7`);
    }
    const open = proposals.filter((p) => p.state === 1).length;
    console.log(`slashes: ${filed.length} agent(s) ever filed against, ${open} pending, none overdue that is not held on purpose`);
  } catch (e) {
    fail(`slashes: could not read them (${e.message})`);
  }
}

/**
 * Two operators' payer-signed outcomes, matched by leg (didHash, txHash, payer). Pure, so it can be
 * tried with `node -e`. Each operator's acceptedAt is its own time of taking the outcome, so for a leg
 * held by one side only it is how long the other has had to import it. An item without a readable
 * leg or acceptedAt is a failure: read as zero or NaN it would pass as in flight forever.
 *
 * @param {[[string, object[]], [string, object[]]]} sides  [name, outcomes as GET /outcomes serves them]
 * @returns {{ failures: string[], inFlight: string[], both: number, widestGapMs: number }}
 *   widestGapMs: the largest difference between the two acceptedAt values of a leg both hold
 */
export function compareOutcomes(sides, { nowMs = Date.now(), lagMs = OUTCOMES_LAG_HOURS * 3_600_000 } = {}) {
  const failures = [];
  const inFlight = [];
  const legOf = (o) => [o.didHash, o.txHash, o.payer].map((v) => v.toLowerCase()).join('|');
  const usable = (o) => o !== null && typeof o === 'object' &&
    [o.didHash, o.txHash, o.payer].every((v) => typeof v === 'string') && Number.isSafeInteger(o.acceptedAt);
  const [a, b] = sides.map(([name, list]) => {
    const held = new Map();
    for (const o of list) {
      if (usable(o)) held.set(legOf(o), o);
      else failures.push(`${name} serves an item that is not an outcome: ${JSON.stringify(o).slice(0, 120)}`);
    }
    return { name, held };
  });
  const what = (o) => `tx ${o.txHash} from ${o.payer} (agent ${o.didHash.slice(0, 10)}…)`;
  let both = 0;
  let widestGapMs = 0;
  for (const [leg, x] of a.held) {
    const y = b.held.get(leg);
    if (!y) continue;
    both += 1;
    widestGapMs = Math.max(widestGapMs, Math.abs(x.acceptedAt - y.acceptedAt));
    if (x.outcome !== y.outcome) failures.push(`${what(x)}: outcome ${x.outcome} on ${a.name}, ${y.outcome} on ${b.name}`);
  }
  for (const [holder, other] of [[a, b], [b, a]]) {
    for (const [leg, x] of holder.held) {
      if (other.held.has(leg)) continue;
      const ageMs = nowMs - x.acceptedAt;
      const line = `${what(x)}: held by ${holder.name}, not ${other.name}, taken ${Math.round(ageMs / 60_000)} minutes ago`;
      // Asked as `<=`, so a lag that is not a number fails rather than waits.
      if (ageMs <= lagMs) inFlight.push(line);
      else failures.push(line);
    }
  }
  return { failures, inFlight, both, widestGapMs };
}

/** Every payer-signed outcome an operator serves, following `next` while `more` is set. */
async function allOutcomes(base) {
  const all = [];
  let since = 0;
  for (;;) {
    const { res, body } = await get(`${base}/outcomes?since=${since}`);
    if (res.status !== 200) throw new Error(`/outcomes?since=${since} status ${res.status}`);
    const j = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(j.outcomes)) throw new Error(`/outcomes?since=${since} has no outcomes list`);
    all.push(...j.outcomes);
    if (j.more !== true) return all;
    // A page that says there is more must move the cursor on, or this would ask for it forever.
    if (!(Number(j.next) > since)) throw new Error(`/outcomes?since=${since} says there is more but next is ${j.next}`);
    since = Number(j.next);
  }
}

async function checkOutcomes() {
  const sides = [];
  for (const [name, base] of [['oracle', ORACLE], ['checker', CHECKER]]) {
    try {
      sides.push([name, await allOutcomes(base)]);
    } catch (e) {
      fail(`${name}: /outcomes unreachable or unreadable (${e.message})`);
    }
  }
  if (sides.length < 2) return;
  const { failures, inFlight, both, widestGapMs } = compareOutcomes(sides);
  for (const f of failures) fail(`outcomes: ${f}`);
  for (const f of inFlight) console.log(`outcomes: in flight, ${f}`);
  console.log(
    `outcomes: oracle ${sides[0][1].length}, checker ${sides[1][1].length}, ${both} on both ` +
    `(taken at most ${Math.round(widestGapMs / 60_000)} minutes apart), ${inFlight.length} in flight, ` +
    `one side only fails after ${OUTCOMES_LAG_HOURS} hours`,
  );
}

// Run only when started as a script, so that `node -e` can import compareOutcomes without
// making a request. Node resolves the entry file's real path for import.meta.url, so this does too.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'all';
  if (!['site', 'services', 'outcomes', 'all'].includes(mode)) {
    console.error('usage: node scripts/check-live.mjs [site|services|outcomes]');
    process.exit(2);
  }
  // A value that is not a number would make every comparison false and pass everything as in flight.
  if (!(OUTCOMES_LAG_HOURS >= 0) || !Number.isFinite(OUTCOMES_LAG_HOURS)) {
    console.error(`OUTCOMES_LAG_HOURS must be a number of hours, got "${process.env.OUTCOMES_LAG_HOURS}"`);
    process.exit(2);
  }
  if (mode === 'site' || mode === 'all') await checkSite();
  if (mode === 'services' || mode === 'all') await checkServices();
  if (mode === 'outcomes' || mode === 'all') await checkOutcomes();

  if (problems.length) {
    console.error('\nlive check: FAILED');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('live check: ok');
}
