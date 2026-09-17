# Sigvara Website Security Deployment Checklist

This checklist is for the static Sigvara website and should be completed before public production launch.

## Required before publishing

| Check | Status | Notes |
|---|---|---|
| Activate and monitor `security@sigvara.xyz` | `[ ]` | Required before publishing `security.txt`. |
| Serve `/.well-known/security.txt` over HTTPS | `[ ]` | Confirm a `200` response and correct `text/plain` content type. |
| Confirm the `Canonical` and `Policy` URLs | `[ ]` | Both must resolve on the final domain. |
| Replace all zero contract addresses | `[ ]` | The current Arc app intentionally remains deployment-pending. |
| Remove private keys, seed phrases, API keys, and tokens | `[ ]` | Search source, build output, Git history, and deployment secrets. |
| Configure one server-header source | `[ ]` | Use `_headers`, `vercel.json`, Nginx, or Apache as appropriate; do not blindly stack conflicting policies. |
| Confirm HTTPS and HSTS behavior | `[ ]` | Only enable HSTS after the entire domain is HTTPS-only. |
| Test the Content Security Policy | `[ ]` | Check browser console, wallet connection, Arc RPC reads, and all documentation pages. |
| Verify wallet actions on a test wallet | `[ ]` | Never use a wallet containing valuable assets for initial testing. |
| Review third-party links and scripts | `[ ]` | The current site has no external JavaScript CDN dependency. |
| Run a dependency and secret scan | `[ ]` | Include npm lockfiles and repository history. |
| Back up the deployment configuration | `[ ]` | Store the known-good configuration privately. |

## Recommended external checks

Run the deployed domain through a security-header scanner, verify the TLS certificate and redirect behavior, inspect the browser console for CSP violations, and confirm that directory listing is disabled. Check that the app cannot send transactions while the deployment manifest is pending and that all published contract addresses match the signed deployment record.

## CSP hardening follow-up

The current policy permits `'unsafe-inline'` because the supplied static pages contain inline CSS and inline JavaScript. This is a compatibility baseline, not the strongest policy. The next hardening step is to move styles and scripts into external files, or use per-response nonces or hashes, then remove `'unsafe-inline'` from both `script-src` and `style-src`.
