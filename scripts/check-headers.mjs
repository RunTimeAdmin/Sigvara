#!/usr/bin/env node
/**
 * One source of response headers for the site, and only one.
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
 * in agreement.
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
 * A real policy, in any of the four formats this repo has used, is the header name
 * followed by a value containing `default-src`. Prose that merely mentions the header
 * does not match, which is what lets this file describe the problem it prevents.
 */
const NAMES = /Content-Security-Policy/i;
const VALUE = /default-src[^"\n]*/i;

/** Directives whose loss would be silent: the page keeps working, the protection does not. */
const REQUIRED = [
  ["script-src 'self'", 'inline script must stay forbidden'],
  ["style-src 'self'", 'inline style must stay forbidden'],
  ["object-src 'none'", 'no plugins'],
  ["frame-ancestors 'none'", 'no framing'],
  ["base-uri 'self'", 'no base tag hijack'],
  // The badge is served from the oracle, so this has to be present or /check renders a
  // broken image on our own page.
  ['https://oracle.sigvara.xyz', 'the badge host must be allowed in img-src'],
];

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
  for (const [needle, why] of REQUIRED) {
    if (!policy.includes(needle)) {
      problems.push(`policy is missing "${needle}" (${why})`);
    }
  }
  const scriptSrc = policy.match(/script-src([^;]*)/);
  if (scriptSrc && scriptSrc[1].includes('unsafe-inline')) {
    problems.push("policy allows 'unsafe-inline' in script-src");
  }
  const styleSrc = policy.match(/style-src([^;]*)/);
  if (styleSrc && styleSrc[1].includes('unsafe-inline')) {
    problems.push("policy allows 'unsafe-inline' in style-src");
  }
}

if (problems.length) {
  console.error('header check: FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`header check: ok (one source, ${show(CANONICAL)})`);
