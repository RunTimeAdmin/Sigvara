#!/usr/bin/env node
/**
 * One source of response headers for the site, and only one, and it says what it should.
 *
 * The site had four copies of the same policy: .htaccess, _headers, vercel.json and
 * nginx-security.conf. Only .htaccess did anything, because the site is served by
 * Apache. The other three sat in the document root being publicly readable and going
 * stale. The failure mode is not that a dead file is untidy, it is that a policy edit
 * lands in three of four places and a later host migration quietly picks up the copy
 * that was missed.
 *
 * That already happened here. Two untracked copies of the site elsewhere in the working
 * tree still carry `script-src 'self' 'unsafe-inline'`, which the live policy dropped.
 *
 * So this refuses to let a second source come back, rather than trying to keep several
 * in agreement. It also compares the one source with an exact list below: every
 * directive of the Content-Security-Policy and every other security header. Checking
 * only that a few strings are present let a policy gain a CDN, `'unsafe-eval'` or a wider
 * connect-src and still pass. Changing the policy on purpose now means changing it here
 * as well, so the change is visible in review twice.
 *
 *   node scripts/check-headers.mjs
 *
 * Everything below inspects the EXTRACTED policy value, never the file text. The first
 * version of this script scanned whole files and failed on its own documentation,
 * because the comment above quotes the unsafe directive it exists to forbid. A checker
 * that cannot tell a policy from a sentence about a policy will eventually be silenced
 * rather than fixed.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SITE = 'site';
const CANONICAL = join(SITE, '.htaccess');
const show = (p) => p.split(sep).join('/');

/**
 * A file declares a policy when it names the header AND carries a real value.
 *
 * Matched in two parts rather than one, after both halves of one expression went wrong.
 * Joining them means guessing the punctuation between name and value, which differs
 * across Apache, Netlify, nginx and JSON. And the value class first excluded `'`, so
 * the capture stopped dead at `'self'` and every directive afterwards read as missing:
 * a false alarm that looks exactly like a policy which lost its directives. A checker
 * whose failure mode is crying wolf on correct input is one that gets commented out.
 *
 * Prose naming the header does not match, because it carries no `default-src`. That is
 * what lets the comment above quote the directives this file exists to forbid.
 */
const NAMES = /Content-Security-Policy/i;
const VALUE = /default-src[^"\n]*/i;

/**
 * The policy, directive by directive. The badge is served from the oracle, so its host
 * has to be in img-src or /check renders a broken image on our own page. The wallet talks
 * to the Arc RPC from the page. /epochs reads its history from the Arc explorer and asks both
 * oracle operators for their evidence and health, so those three hosts are in connect-src too.
 * The policy is site-wide, so /app may reach them as well; the pages only read from them today.
 */
const EXPECTED_CSP = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'https://oracle.sigvara.xyz'],
  'font-src': ["'self'"],
  'connect-src': ["'self'", 'https://rpc.testnet.arc.io', 'https://explorer.testnet.arc.io', 'https://oracle.sigvara.xyz', 'https://checker.sigvara.xyz'],
  'upgrade-insecure-requests': [],
};

/** Every other header the file may set, and its exact value. */
const EXPECTED_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const problems = [];
let policy = null;

for await (const file of walk(SITE)) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue; // unreadable or binary: declares nothing either way
  }
  // Both, or it is prose about a policy rather than a policy.
  if (!NAMES.test(text)) continue;
  const found = text.match(VALUE);
  if (!found) continue;

  if (relative(CANONICAL, file) === '') policy = found[0].trim();
  else problems.push(`${show(file)} also defines a policy; ${show(CANONICAL)} is the only source`);
}

if (policy === null) {
  problems.push(`${show(CANONICAL)} defines no Content-Security-Policy`);
} else {
  const actual = new Map();
  for (const part of policy.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    actual.set(name, sources);
  }
  for (const [name, want] of Object.entries(EXPECTED_CSP)) {
    const got = actual.get(name);
    if (!got) { problems.push(`policy is missing the directive "${name}"`); continue; }
    if ([...got].sort().join(' ') !== [...want].sort().join(' ')) {
      problems.push(`policy directive "${name}" is "${got.join(' ')}", expected "${want.join(' ')}"`);
    }
  }
  for (const name of actual.keys()) {
    if (!(name in EXPECTED_CSP)) problems.push(`policy has an unexpected directive "${name}"`);
  }
}

// The other headers, read from the file's real directives (comments are skipped).
const htaccess = await readFile(CANONICAL, 'utf8');
const set = new Map();
for (const line of htaccess.split('\n')) {
  const m = /^\s*Header\s+always\s+set\s+(\S+)\s+"([^"]*)"\s*$/i.exec(line);
  if (m && m[1].toLowerCase() !== 'content-security-policy') set.set(m[1], m[2]);
}
for (const [name, want] of Object.entries(EXPECTED_HEADERS)) {
  if (!set.has(name)) problems.push(`header "${name}" is not set`);
  else if (set.get(name) !== want) problems.push(`header "${name}" is "${set.get(name)}", expected "${want}"`);
}
for (const name of set.keys()) {
  if (!(name in EXPECTED_HEADERS)) problems.push(`unexpected header "${name}" (add it to EXPECTED_HEADERS if it is intended)`);
}

// Missing and refused paths must get the site's own page, which carries these headers.
// The host's default page loads third-party scripts and carries none of them.
for (const code of [404, 403]) {
  if (!new RegExp(`^\\s*ErrorDocument\\s+${code}\\s+/404\\.html\\s*$`, 'm').test(htaccess)) {
    problems.push(`${show(CANONICAL)} has no "ErrorDocument ${code} /404.html"`);
  }
}
try {
  const page = await readFile(join(SITE, '404.html'), 'utf8');
  if (/<script/i.test(page)) problems.push('site/404.html contains a script');
  if (/\sstyle\s*=/i.test(page)) problems.push('site/404.html contains an inline style');
  if (/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(page)) problems.push('site/404.html points at another origin');
} catch {
  problems.push('site/404.html is missing');
}

if (problems.length) {
  console.error('header check: FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`header check: ok (one source, ${show(CANONICAL)}, policy and ${Object.keys(EXPECTED_HEADERS).length} headers match, 404 page in place)`);
