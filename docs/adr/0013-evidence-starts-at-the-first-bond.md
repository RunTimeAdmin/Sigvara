# ADR 0013: An agent's evidence starts at its first bond

**Status:** Accepted · 2026-11-16, the owner's choice of option B (section 3) over a registration fee. Rollout steps
1, 2 and 4 are built: `noteBond`, `ACTIVE_AT_REGISTRATION_BEFORE` and the catch-up in `getRegisteredAgents`
(`oracle/chain.js`), `before_bond` in
`planCredits` (`oracle/payment-scan.js`) and `scanChain` (`oracle/payment-chains.js`), and `bondedByPayment` and the
bonded agent list in `oracle/index.js`, tested in `oracle/first-bond.test.js` and beside each. Step 3, both testnet
operators, is not done yet. Code references in sections 1 and 3 are to main at `9be7aa7`, before the build.

## 1. Context

- **Registering costs only gas.** `registerAgent` checks the agent's signature and that the DID is new, and nothing
  else; inflows being open is its only gate (`src/SigvaraIdentity.sol:297-322`). A new agent starts `PendingBond`
  (`src/SigvaraIdentity.sol:47-56`). The project's own estimate is about 50 USDC of gas on Arc mainnet for 10,000
  registrations (`oracle/bond-watch.js:14-16`).
- **A first bond is one fact on chain.** The deposit that first carries a `PendingBond` agent over `minimumStake` makes
  it `Active` (`src/SigvaraStaking.sol:358-364`). `updateStatus` refuses `Active` without the minimum stake, whoever
  calls it (`src/SigvaraIdentity.sol:384-387`), and nothing returns to `PendingBond`
  (`src/SigvaraIdentity.sol:350-352`). Each change emits `AgentStatusUpdated` (`src/SigvaraIdentity.sol:398`). An
  agent's first `AgentStatusUpdated(did, Active)` log is therefore the block its first bond landed in, and every
  operator reads the same one.
- **The oracle's work grows with every registration.** The registry scan keeps each registration until a slash prunes
  it (`oracle/chain.js:178`, `289-299`, `323-325`) and saves the whole list (`oracle/chain.js:238-240`). Each epoch the
  payment scan asks for 50 recipients per `getLogs` call (`oracle/payment-scan.js:57`, `433-457`) across every known
  agent (`oracle/index.js:1212-1231`), and each payment chain's scan does the same
  (`oracle/payment-chains.js:566-577`). bond-watch reads every agent without a bond once a day
  (`oracle/bond-watch.js:1-16`). The epoch already leaves an unbonded agent unwritten
  (`oracle/index.js:1832-1888`), so for an agent that never bonds this work buys nothing.
- **What that costs.** An estimate from the code's pacing, not a measurement: at mainnet's settings each registration
  adds about 0.02 s of payment scan per chain per epoch and 0.01 s of bond-watch reads. Somewhere between 70,000
  registrations (with a payment chain) and 120,000 (without), one epoch runs past an hour, for 350 to 600 USDC of gas.
  Scores go stale. Nothing is scored wrongly and no money moves. A security review on 16 November 2026 rated this
  Medium.
- **Evidence already starts at a chain fact.** A payment made before the agent's registration block is refused as
  `before_registration`: by the scan (`oracle/payment-scan.js:248-249`), by `POST /attest`
  (`oracle/index.js:3744`), by peer import (`oracle/index.js:2981`), and on a payment chain by block time
  (`oracle/payment-chains.js:662`, `746`). The registration's own block counts.
- **No payment scan reads past the registry scan.** The scored chain's stops at the last block the registry scan has
  read (`oracle/index.js:1191-1197`), and a payment chain's at that block's time
  (`oracle/payment-chains.js:547-556`). A log the registry scan reads is known before any payment after it is.
- **Testnet, 16 November 2026.** 47 registrations, 46 with an `Active` log, each within 144 blocks of its
  registration. The 47th and oldest, the demo agent, registered on 18 September in block 62664031, before the identity
  proxy moved to the PendingBond implementation in block 62914014 (its `Upgraded` log). The registry of the time made
  it `Active` at registration, and it is `Active` now with no status log. No agent left `PendingBond` for `Suspended`
  first.

## 2. What any answer must keep

1. A root already published, or committed in a pending proposal, still reproduces from the operator's state.
2. Both operators reach the same answer from the chain alone, so the checker can audit it.
3. An epoch's reads grow with the agents that have bonded, not with registrations.
4. An honest agent that bonds before it is paid loses nothing.

## 3. Options considered

**A. A registration fee or bond in `registerAgent`.** It makes the registry itself costly to fill, so the `/agents`
lobby and explorers stay clean as well. It needs an identity upgrade, changes the SDK's and the site's register
flows and the simulations, and the oracle would still read every agent that paid the fee. Not chosen. It can still
come later.

**B. Evidence starts at the first bond. Chosen.**
1. The registry scan reads `AgentStatusUpdated` beside `AgentRegistered` and `OperatorTransferred`, in the same calls
   (`oracle/chain.js:270`). An agent's first `Active` log gives it `bondedBlock`, kept on its record and saved with
   it. A payment chain's check reads that block's time when it needs it. A registration made while a registry still
   started agents `Active` is bonded from its own block: on Arc testnet's identity proxy, one before block 62914014.
   The oracle names that block for that proxy alone; a registry it does not name started every agent at
   `PendingBond`.
2. The epoch, the scored chain's payment scan and each payment chain's scan work from agents with a `bondedBlock`. A
   registration that never bonded stays a record in the registry scan, so that its operator history is whole if it
   bonds later, and nothing reads it again. The link scan keeps every registration, since it asks nothing per agent
   (`oracle/index.js:995-1000`).
3. A payment counts for an agent only from its first bond: on the scored chain from `bondedBlock`, that block
   included, and on a payment chain from that block's time, as `before_registration` works now. An earlier payment is
   refused as `before_bond` by the scan, by `POST /attest` (402) and by peer import.
4. `POST /attest` reads the agent at the payment's block, as it does now (`oracle/index.js:2626-2628`). `Active` there
   means it had bonded, and `PendingBond` means `before_bond`. An operator can suspend an agent that never bonded, so
   a `Suspended` agent is checked against `bondedBlock`, and the answer is 503 (`bond_not_seen`) until the registry
   scan has read the payment's block. A slashed agent is scored no more, so its payments are taken as before. On a
   payment chain the agent is read as it stands today, so only `PendingBond` answers on its own there.
5. The rule applies to payments credited from the upgrade on. A credit already held stays, and so do the roots built
   from it.
6. At its first start with this rule, an operator reads the identity registry's status logs once, up to where its
   registry scan had read, to find the first bonds of the agents it already knows. No agent bonds before it registers,
   so each read starts at the oldest registration still without a bond and the blocks between are left: on testnet
   about one read per agent, where reading every 10,000 blocks since the oldest registration would be about 1,000. It
   reads no registration again, so an agent it had forgotten after a slash does not come back. The scan state saves
   how far status logs have been read; an earlier build drops that field, and the next start with this rule reads them
   again and keeps every bond it holds.

**C. Read agents that never bonded less often.** A slower sweep for `PendingBond` agents. It lowers the cost without
bounding it, and a payment credited late changes when it counts. Rejected.

**D. Count only agents bonded now.** It would bound the scans by the stake bonded at any moment. It needs each agent's
stake at each payment's block: a read per payment, or the whole stake and minimum history from logs. Rejected for
B's single fact per agent.

## 4. Parameters

| Parameter | Set |
|---|---|
| What starts an agent's evidence | Its first `AgentStatusUpdated(did, Active)` log |
| A payment in the bond's own block | Counts, as one in the registration's block does |
| A payment on a payment chain | Compared by block time with the bond block's time |
| Credits held at the upgrade | Kept |
| Refusal code | `before_bond`; `POST /attest` answers 402, or 503 with `bond_not_seen` while it cannot tell yet |

## 5. Consequences

- An epoch's reads, the payment scans' calls and bond-watch's daily sweep grow with bonded agents only. A
  registration that never bonds costs the oracle one log in the registry scan and its record: about 800 bytes of
  memory and 220 in the saved state, measured on 16 November with records shaped as `oracle/chain.js:289-299`.
- Filling the payment scans takes the minimum stake per agent, locked for the unbonding period and slashable, where
  it took gas. On testnet SVR comes from a faucet, so the faucet's cooldown is the limit there.
- An agent paid before its bond loses those payments. The quickstart already says to bond after registering
  (`docs/quickstart.md`, step 5); it will say why.
- `POST /attest` answers 503 for a payment to a `Suspended` agent until the registry scan has read the payment's
  block, at most an epoch.
- `/health` reports how many agents are registered and how many have bonded (`agents`), so the two operators can be
  compared.
- The saved state grows by one number per bonded agent, and one for how far status logs have been read.

## 6. What this does not do

- It does not make registrations free to keep. At about 800 bytes each, a few hundred thousand that never bond, on the
  order of 2,000 USDC of gas, would still fill the 768 MiB the mainnet compose file allows
  (`docker-compose.mainnet.yml:47`). Keeping a compact record, or none, for an agent that never bonded is the next
  step. It is not part of this ADR.
- It does not bound bonds reused across agents. An operator can bond an agent, suspend it, withdraw after the
  unbonding period and bond the next, and each stays in the scans. That costs the minimum stake for one unbonding
  period per agent. Option D would bound it.
- It changes no contract. If `updateStatus` refused `PendingBond` to `Suspended`, the status at the payment's block
  would say on its own whether an agent had bonded, and step 4's 503 would go. That can go with a later identity
  upgrade.
- It does not keep registrations out of the registry, the `/agents` lobby or explorers. Option A would.

## 7. Rollout

1. Oracle: option B, with `before_bond` in the scan, `POST /attest`, peer import and each payment chain, and the counts
   on `/health`.
2. Tests: registrations that never bond add no reads to an epoch; a payment before the bond is refused by the scan, a
   payment chain's scan and `POST /attest`, and one in the bond's block counts; a `Suspended` agent that never bonded
   is refused, or waited for while unread; the first start finds the bonds of agents already known, once, with a read
   at each registration rather than across the span, and puts no forgotten agent back; a testnet registration from
   before PendingBond counts from its block; a credit held from before the upgrade stays. Peer import shares
   `POST /attest`'s check.
3. Both Arc testnet operators in one window between epochs (they run at about :57 and :58), as with #301, then their
   `/health` counts compared. Mainnet starts with the rule.
4. Docs: `docs/payment-backed-attestations.md` (the rule and `before_bond`), `docs/quickstart.md` step 5, and
   `oracle/README.md`.
