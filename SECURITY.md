# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@sigvara.xyz**. Do not open a public issue for an unpatched vulnerability or include private keys, seed phrases, API keys, access tokens, or personal information in a report.

Include the affected component, impact, reproduction steps, relevant logs or request details with secrets removed, and any suggested mitigation. Good-faith research should avoid service degradation, privacy violations, credential theft, social engineering, spam, data destruction, and unauthorized access to third-party systems.

The deployed website has additional guidance at [site/SECURITY.md](site/SECURITY.md). The production disclosure endpoint is [/.well-known/security.txt](https://sigvara.xyz/.well-known/security.txt).

## Scope

In scope are the Sigvara smart contracts, SDK, oracle, static website, client-side wallet flows, deployment configuration, and publicly served configuration maintained in this repository. Issues in Arc, wallet providers, RPC providers, or third-party CounterAudit services should also be reported to the relevant provider.

The current website and contract configuration target Arc Testnet. Testnet assets have no economic value. Do not test with valuable assets or accounts you do not own.

## Response targets

The project aims to acknowledge reports within five business days, provide an initial assessment within ten business days, and coordinate a fix or mitigation with the reporter. These are targets, not a guarantee. Public disclosure timing should be coordinated after a fix is available.

## Supported versions

The `main` branch is the active development target. Deployed contract versions and legacy deployments must be evaluated against their corresponding release documentation and deployment manifest.
