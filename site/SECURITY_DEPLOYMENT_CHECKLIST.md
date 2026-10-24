# Sigvara Website Security Deployment Checklist

This checklist is for the static Sigvara website and should be completed before public production launch.

## Required before publishing

| Check | Status | Notes |
|---|---|---|
| Activate and monitor `security@sigvara.xyz` | `[x]` | Active alias of `support@sigvara.xyz`, which forwards to the maintainer's inbox (mail configuration read on 24 Oct 2026). Send a test from an outside account after any mail change. |
| Serve `/.well-known/security.txt` over HTTPS | `[x]` | `200`, `text/plain` (checked 24 Oct 2026). |
| Confirm the `Canonical` and `Policy` URLs | `[x]` | Both resolve (24 Oct 2026). |
| Replace all zero contract addresses | `[x]` | Done. The only zero address left is the fee registry in `site/assets/app.js`, because `SigvaraEpochFees` is not deployed. |
| Remove private keys, seed phrases, API keys, and tokens | `[x]` | All 443 commits, the wiki, unreachable objects and PR text were scanned on 24 Oct 2026: none. `scripts/check-secrets.mjs` now runs in CI. |
| Configure one server-header source | `[x]` | `site/.htaccess` (Apache) is the only source. `scripts/check-headers.mjs` fails the build if a second one appears. |
| Confirm HTTPS and HSTS behavior | `[x]` | http redirects to https; HSTS `max-age=31536000; includeSubDomains`; TLS 1.3, TLS 1.0/1.1 refused (24 Oct 2026). |
| Test the Content Security Policy | `[x]` | `/app` exercised in a real browser against Arc testnet with a clean console (PR 76, 24 Oct 2026). The host's default 404 page does not carry the policy; see `site/404.html`. |
| Verify wallet actions on a test wallet | `[ ]` | Never use a wallet containing valuable assets for initial testing. |
| Review third-party links and scripts | `[ ]` | The current site has no external JavaScript CDN dependency. |
| Run a dependency and secret scan | `[x]` | `npm audit`: 0 runtime advisories in `oracle` and `packages/sdk` (dev-only advisories in the SDK tree); history scan clean (24 Oct 2026). |
| Back up the deployment configuration | `[ ]` | Store the known-good configuration privately. |

## Recommended external checks

Run the deployed domain through a security-header scanner, verify the TLS certificate and redirect behavior, inspect the browser console for CSP violations, and confirm that directory listing is disabled. Check that all published contract addresses match `deployments/5042002.json` (`scripts/check-docs.mjs` flags a stale copy of a deployed address on every push).

## Content Security Policy

The policy allows no inline script or style (`script-src 'self'`, `style-src 'self'`). `scripts/check-headers.mjs` fails the build if either directive gains `'unsafe-inline'`.
