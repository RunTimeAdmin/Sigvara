#!/usr/bin/env node
/**
 * Looks at the live deployment from outside, the way a visitor and an attacker would.
 *
 *   node scripts/check-live.mjs site       every deployed file equals what main says
 *   node scripts/check-live.mjs services   oracle and checker answer, certificates are not near expiry
 *   node scripts/check-live.mjs            both
 *
 * Why it exists. The site is uploaded by hand and nothing signs or verifies what reaches
 * users, yet `assets/app.js` decides what a wallet is asked to sign. If a hosting account,
 * a neighbouring site or the CDN changes a file, nobody would notice until a user did.
 * This compares the bytes users receive with the bytes in git, so a change that is not a
 * reviewed commit shows up within the hour. It also fires when a merged site change has not
 * been uploaded yet, which the deploy notes say has been forgotten more than once.
 *
 * It runs from GitHub Actions on a schedule (.github/workflows/live-checks.yml), a place
 * that shares no account, host or credential with the things it watches. A failed run
 * emails the repository owner, which makes it a second alert path beside the Discord
 * watcher: it does not depend on the three servers being up.
 *
 * Reads only. Every request is a GET to a public URL.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

const SITE = process.env.SITE_BASE || 'https://sigvara.xyz';
const ORACLE = process.env.ORACLE_BASE || 'https://oracle.sigvara.xyz';
const CHECKER = process.env.CHECKER_BASE || 'https://checker.sigvara.xyz';
const EPOCH_STALE_MS = 3 * 3600 * 1000;       // the oracle runs hourly; three hours is a missed run
const CERT_MIN_DAYS = 14;
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

/** Header values the policy file promises, parsed from the file that is deployed. */
function promisedHeaders() {
  const text = readFileSync('site/.htaccess', 'utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*Header\s+always\s+set\s+(\S+)\s+"([^"]*)"\s*$/i.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
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
  // what the file promises, on the pages that matter most.
  const promised = promisedHeaders();
  for (const path of ['/', '/app', '/assets/app.js']) {
    try {
      const { res } = await get(SITE + path + `?cb=${Date.now()}`);
      for (const [name, value] of promised) {
        const got = res.headers.get(name);
        if (got !== value) fail(`${path}: header ${name} is ${got === null ? 'missing' : `"${got.slice(0, 80)}"`}, .htaccess promises "${value.slice(0, 80)}"`);
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
  try {
    const { res, body } = await get(CHECKER + '/divergence');
    const j = JSON.parse(body.toString('utf8'));
    if (res.status !== 200) fail(`checker: /divergence status ${res.status}`);
    else if (j.mode !== 'checker') fail(`checker: /divergence reports mode "${j.mode}"`);
    else if (j.seesProposals === false) fail('checker: its epoch is too long to see proposals before they expire');
    else if (Array.isArray(j.divergences) && j.divergences.length > 0) fail(`checker: ${j.divergences.length} recorded divergence(s) from the primary, see ${CHECKER}/divergence`);
  } catch (e) {
    fail(`checker: /divergence unreachable or unreadable (${e.message})`);
  }
  for (const host of new URL(SITE).host === 'sigvara.xyz' ? ['sigvara.xyz', 'oracle.sigvara.xyz', 'checker.sigvara.xyz'] : []) {
    try {
      const days = await certDaysLeft(host);
      if (days < CERT_MIN_DAYS) fail(`${host}: certificate expires in ${days.toFixed(1)} days`);
    } catch (e) {
      fail(`${host}: certificate check failed (${e.message})`);
    }
  }
  console.log('services: oracle and checker health, divergence list and certificate expiry checked');
}

const mode = process.argv[2] || 'all';
if (!['site', 'services', 'all'].includes(mode)) {
  console.error('usage: node scripts/check-live.mjs [site|services]');
  process.exit(2);
}
if (mode === 'site' || mode === 'all') await checkSite();
if (mode === 'services' || mode === 'all') await checkServices();

if (problems.length) {
  console.error('\nlive check: FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('live check: ok');
