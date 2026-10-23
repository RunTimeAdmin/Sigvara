# Sigvara Website Security Deployment Checklist

This checklist is for the static Sigvara website and should be completed before public production launch.

## Required before publishing

| Check | Status | Notes |
|---|---|---|
| Activate and monitor `security@sigvara.xyz` | `[ ]` | Required before publishing `security.txt`. |
| Serve `/.well-known/security.txt` over HTTPS | `[ ]` | Confirm a `200` response and correct `text/plain` content type. |
| Confirm the `Canonical` and `Policy` URLs | `[ ]` | Both must resolve on the final domain. |
| Replace all zero contract addresses | `[x]` | Done. The only zero address left is the fee registry in `site/assets/app.js`, because `SigvaraEpochFees` is not deployed. |
| Remove private keys, seed phrases, API keys, and tokens | `[ ]` | Search source, build output, Git history, and deployment secrets. |
| Configure one server-header source | `[x]` | `site/.htaccess` (Apache) is the only source. `scripts/check-headers.mjs` fails the build if a second one appears. |
| Confirm HTTPS and HSTS behavior | `[ ]` | Only enable HSTS after the entire domain is HTTPS-only. |
| Test the Content Security Policy | `[ ]` | Check browser console, wallet connection, Arc RPC reads, and all documentation pages. |
| Verify wallet actions on a test wallet | `[ ]` | Never use a wallet containing valuable assets for initial testing. |
| Review third-party links and scripts | `[ ]` | The current site has no external JavaScript CDN dependency. |
| Run a dependency and secret scan | `[ ]` | Include npm lockfiles and repository history. |
| Back up the deployment configuration | `[ ]` | Store the known-good configuration privately. |

## Recommended external checks

Run the deployed domain through a security-header scanner, verify the TLS certificate and redirect behavior, inspect the browser console for CSP violations, and confirm that directory listing is disabled. Check that all published contract addresses match `deployments/5042002.json` (`scripts/check-docs.mjs` flags a stale copy of a deployed address on every push).

## Content Security Policy

The policy allows no inline script or style (`script-src 'self'`, `style-src 'self'`). `scripts/check-headers.mjs` fails the build if either directive gains `'unsafe-inline'`.
