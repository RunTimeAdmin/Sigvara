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
 * nacl-fast.min.js and broken Ed25519 on the demo page. The manifest is printed so it
 * can be read before anything is sent.
 *
 * The archive holds the files git tracks, and nothing else. It used to zip the working
 * tree, which published any untracked file lying in site/ (a backup, a draft, a scratch
 * folder). Untracked files now stop the build. Git-ignored files are left out on purpose;
 * the one the live site needs (assets/sigvara-card.png) has to be uploaded by hand.
 *
 * The live site is NOT deployed from this archive. A static-archive deploy replaces the
 * whole document root. Upload the changed files over TUS instead (docs/deploy-testnet.md
 * section 8) and check the result with scripts/check-live.mjs.
 *
 *   node scripts/package-site.mjs          # check, then build site.zip
 *   node scripts/package-site.mjs --check  # check only
 */

import { execFileSync } from 'node:child_process';
import { statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const out = join(root, 'sigvara-site.zip');

// Never published. Repo-facing documents that happen to live under site/.
const EXCLUDE = new Set(['SECURITY.md', 'SECURITY_DEPLOYMENT_CHECKLIST.md']);
const isExcluded = rel => EXCLUDE.has(rel) || rel.endsWith('.zip');

const gitList = (args) => execFileSync('git', [...args, 'site'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).map(p => p.replace(/^site\//, ''));
const trackedFiles = () => gitList(['ls-files', '-z']);
const untrackedFiles = () => gitList(['ls-files', '-z', '--others', '--exclude-standard']);

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

const untracked = untrackedFiles();
if (untracked.length) {
  console.error('\nRefusing to package: site/ holds files git does not track (add them, or ignore them):');
  for (const f of untracked) console.error('  ' + f);
  process.exit(1);
}

if (process.argv.includes('--check')) process.exit(0);

// ---- build ----------------------------------------------------------------
const all = trackedFiles().sort();
const included = all.filter(f => !isExcluded(f));
const skipped = all.filter(isExcluded);

if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-q', out, '-@'], { cwd: siteDir, input: included.join('\n') + '\n' });

const size = statSync(out).size;
console.log(`\npackaged ${included.length} files, ${size} bytes -> ${relative(root, out)}`);
for (const f of included) console.log(`  ${f}`);
if (skipped.length) {
  console.log('\ndeliberately not published:');
  for (const f of skipped) console.log(`  ${f}`);
}
console.log('\nThis archive is for reference or for a new, empty host. Do NOT deploy it to the live');
console.log('site as a static archive: that replaces the whole document root and deletes files');
console.log('that exist only on the host (assets/sigvara-card.png is git-ignored but served).');
console.log('Upload only the changed files over TUS, clear the cache, then run');
console.log('node scripts/check-live.mjs site. See docs/deploy-testnet.md section 8.');
