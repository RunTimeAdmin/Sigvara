/**
 * Local static server for site/, with the production URL behaviour.
 *
 * Two things the plain `python -m http.server` gets wrong for this site, both of which
 * hide real bugs until they are live:
 *
 *   - Extensionless URLs. Production rewrites /docs/reputation to reputation.html via
 *     .htaccess. Without that, every internal link 404s locally, so the one thing you
 *     would want to check before deploying is exactly the thing you cannot.
 *   - The Content-Security-Policy. The site loads no external scripts on purpose, and
 *     the CSP is what enforces it. Serving without the header means a violation that
 *     would break the live page passes locally in silence.
 *
 * Pass --csp to send the headers from site/.htaccess. Without it, headers are omitted,
 * which is occasionally useful for isolating whether a failure is the CSP or the code.
 *
 *   node scripts/serve-site.mjs [--csp] [--port 4173]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const args = process.argv.slice(2);
const withCsp = args.includes('--csp');
const port = Number(args[args.indexOf('--port') + 1]) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

// Lifted from site/.htaccess rather than restated, so the two cannot drift apart.
async function productionHeaders() {
  const htaccess = await readFile(join(root, '.htaccess'), 'utf8');
  const headers = {};
  for (const m of htaccess.matchAll(/Header always set ([\w-]+) "([^"]*)"/g)) {
    headers[m[1]] = m[2];
  }
  return headers;
}

const headers = withCsp ? await productionHeaders() : {};

async function resolve(pathname) {
  // Contain the path before touching disk: a request for /../../.env must not escape.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = join(root, rel);
  if (!target.startsWith(root)) return null;

  for (const candidate of [target, `${target}.html`, join(target, 'index.html')]) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch { /* try the next shape */ }
  }
  return null;
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const file = await resolve(pathname === '/' ? '/index.html' : pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404');
  }
  const body = await readFile(file);
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}).listen(port, '127.0.0.1', () => {
  console.log(`site/ on http://127.0.0.1:${port}  (CSP ${withCsp ? 'on' : 'off'}, extensionless URLs on)`);
});
