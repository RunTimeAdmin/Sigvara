/**
 * Builds the site archive for deployment, refusing to build a bad one.
 *
 * Two things went wrong doing this by hand, and both are encoded here.
 *
 * The exclusion list matters more than it looks. site/ contains
 * SECURITY_DEPLOYMENT_CHECKLIST.md, an internal pre-launch checklist that has never
 * been published. A plain `zip -r` of the directory puts it on the public web.
 *
 * And the deploy overwrites the document root, so anything the host serves that is not
 * in the archive is deleted. The file listing returned by the hosting API did not
 * recurse into assets/vendor/, so a manifest built from it would have silently dropped
 * nacl-fast.min.js and broken Ed25519 on the demo page. The archive is built from the
 * working tree, and the manifest is printed so it can be read before anything is sent.
 *
 *   node scripts/package-site.mjs          # check, then build site.zip
 *   node scripts/package-site.mjs --check  # check only
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const out = join(root, 'sigvara-site.zip');

// Never published. Repo-facing documents that happen to live under site/.
const EXCLUDE = new Set(['SECURITY.md', 'SECURITY_DEPLOYMENT_CHECKLIST.md']);
const isExcluded = rel => EXCLUDE.has(rel) || rel.endsWith('.zip');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(relative(siteDir, full).split('\\').join('/'));
  }
  return files;
}

// ---- gate -----------------------------------------------------------------
// The check reads src/*.sol and asserts the site still describes it accurately. A
// deploy that publishes a page contradicting the contracts is worse than no deploy,
// so this runs first and a failure stops the build rather than warning about it.
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'check-docs.mjs')], { stdio: 'inherit' });
} catch {
  console.error('\nRefusing to package: the site disagrees with the contracts.');
  process.exit(1);
}

if (process.argv.includes('--check')) process.exit(0);

// ---- build ----------------------------------------------------------------
const included = walk(siteDir).filter(f => !isExcluded(f)).sort();
const skipped = walk(siteDir).filter(isExcluded).sort();

if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-r', '-q', out, '.', '-x', ...[...EXCLUDE].map(String), '*.zip'], { cwd: siteDir });

const size = statSync(out).size;
console.log(`\npackaged ${included.length} files, ${size} bytes -> ${relative(root, out)}`);
for (const f of included) console.log(`  ${f}`);
if (skipped.length) {
  console.log('\ndeliberately not published:');
  for (const f of skipped) console.log(`  ${f}`);
}
console.log('\nUpload this to public_html and deploy it as a static archive. The deploy');
console.log('replaces the document root, so this list is exactly what the site will serve.');
