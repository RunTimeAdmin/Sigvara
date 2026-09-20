# Who builds this

Sigvara is built by **David Cooper** (CCIE #14019).

- GitHub: [RunTimeAdmin](https://github.com/RunTimeAdmin)
- Sites: [protocol14019.com](https://protocol14019.com), [runtimeadmin.com](https://runtimeadmin.com)
- X: [@defiauditccie](https://x.com/defiauditccie)
- Contact: david@runtimeadmin.com

The GitHub account is newer as a public publishing surface; the credentials and career behind it are longer.

These are builder/personal links, not Sigvara project channels. Project announcements and support go only through the four surfaces in [docs/token.md](token.md): [sigvara.xyz](https://sigvara.xyz), this repo, [@SigvaraProtocol](https://x.com/SigvaraProtocol), and the security contact.

---

## Active focus

**Sigvara** (this repo) — computed reputation and staked slashing for autonomous AI agents on top of ERC-8004.

---

## Adjacent public tools

Other open-source work in the same practice area:

| Repository | Purpose |
|---|---|
| [counterscarp](https://github.com/RunTimeAdmin/counterscarp) | Smart-contract security analysis (EVM + Solana) |
| [sbomix](https://github.com/RunTimeAdmin/sbomix) | SBOM generation and analysis |
| [mcpshield-action](https://github.com/RunTimeAdmin/mcpshield-action) | GitHub Action for MCP security scanning |
| [Countersig-Public](https://github.com/RunTimeAdmin/Countersig-Public) | Public documentation and specs for the Countersig platform |
| [runtime-fence-ai](https://github.com/RunTimeAdmin/runtime-fence-ai) | Emergency kill-switch / runtime safety for autonomous agents |

---

## Countersig vs. Sigvara

Same builder, different trust models.

- **Countersig** ([countersig.com](https://countersig.com)) is a hosted non-human-identity verification platform — centralized, with its own trust assumptions.
- **Sigvara** (this repo) is the decentralized protocol: on-chain reputation and bonds on ERC-8004. Trust is enforced by cryptography and cryptoeconomics.

Countersig does not read from or write to Sigvara state today. Planned CounterAegis policy gating on `meetsThreshold()` would have Countersig reading Sigvara standing, not writing it. They are separate products that happen to share an author. See [docs/lineage.md](lineage.md) for the naming history.

---

## Token and bond policy

For everything about the SVR token — contract address, distribution, treasury policy, when utility starts — see:

- [docs/token.md](token.md)
- [sigvara.xyz](https://sigvara.xyz)

Those are the only authoritative sources.
