# Sigvara Website Security

## Reporting a vulnerability

Please report suspected security vulnerabilities privately to **security@sigvara.xyz**. Do not open a public GitHub issue for an unpatched vulnerability, publish exploit details, or contact users or wallets affected by a suspected issue.

Include enough information to reproduce the issue, including the affected URL or file, the impact, reproduction steps, relevant request or response details with secrets removed, and any suggested mitigation. Never include private keys, seed phrases, API keys, access tokens, or personal information in a report.

If the security mailbox has not been activated yet, activate it before publishing `/.well-known/security.txt`. The address in that file must be monitored by the project team.

## Scope

In scope are vulnerabilities in the Sigvara website, its static assets, client-side wallet flows, publicly served configuration, and deployment configuration maintained in this repository. Reported issues involving the underlying Arc network, wallet providers, RPC providers, or third-party CounterAudit services should be sent to the relevant provider as well, with Sigvara context included when useful.

The website currently targets Arc Testnet. Testnet contracts and test tokens have no economic value. Do not test against accounts, private keys, production systems, or third-party infrastructure without authorization.

## Safe-harbor expectations

Good-faith research is welcome when it avoids privacy violations, service degradation, data destruction, persistence, credential theft, social engineering, spam, and actions that affect other users. Stop testing and report immediately if you encounter user data, secrets, or a production credential.

## Response targets

The project aims to acknowledge reports within five business days, provide an initial assessment within ten business days, and coordinate a fix or mitigation with the reporter. These are targets, not a guarantee. Public disclosure timing should be coordinated after a fix is available.

## Deployment security requirements

Before production launch, the team must activate the security mailbox, replace every placeholder contract address, confirm the deployment manifest, review CSP and security headers on the actual host, and verify that no private material is present in the repository or generated site bundle.
