# If an operator's signing key may be stolen

Written on 24 October 2026 after a review found no ordered sequence for this anywhere in the repository. The oracle's signing key sits in a `.env` file on a rented server, so assume it will leak one day. This is the order to work in, who can do each step, and what to keep.

An operator is registered in one of two shapes. With **no signer named**, the key is the operator and owns the bond: a thief can start the 7-day unbond. Both testnet operators are registered this way, although the testnet contracts have run the code on `main` since 26 October 2026 and so support the second shape. With **a signer named** (ADR 0004), the owner of the bond names a separate signer, so a stolen signer is revoked in one transaction by someone who is not on the server, and it can never move the bond. Mainnet launches with the second shape. A testnet operator can move to it: it calls `setSigner` with its own key, and the admin grants `ORACLE_ROLE` to the new signer, because naming a signer grants no role. Who can do each step also differs between testnet and mainnet, and those differences are marked.

What a thief can do with the key before you act: propose scores (they finalize after the challenge window unless the committee rejects them), finalize pending ones, charge epoch fees if a fee registry is wired, and, when no signer is named, start the unbond and withdraw the bond after the cooldown unless it is slashed first.

## When to start

Any of these is enough: the `.env` or a copy of it was readable by someone it should not have been; unexplained transactions from the operator address; a login on the box nobody made; a `/health` `commit` that nobody deployed; the box was compromised for any reason (the key lives in the container environment, so host access is key access).

## 1. Contain, in this order, in the first half hour

1. **Stop the process that holds the key.** On the box: `docker compose stop` in the project directory. Do this first and do not delete anything. The other operator keeps scoring or auditing.
2. **Take the key's authority away on chain.** Who can: the deployer on the testnet, the admin Safe on mainnet.
   - `revokeRole(ORACLE_ROLE, <key>)` on `SigvaraReputation`. `finalizeReputation` then refuses a proposal whose proposer no longer holds the role.
   - `removeOperator(<key>)` on `SigvaraOracleBond` (admin). If the key is only a signer, the bond owner calls `clearSigner()` instead (any status works). Neither testnet operator has a signer named, so that case does not arise there yet.
   - If funds could move, the guardian calls `pauseInflows()` (the admin can lift it). It closes registrations, deposits, proposals and bonds for 3 days and moves nothing.
3. **Reject what it already proposed.** The committee calls `rejectReputation(didHash)` for every pending proposal from that key, before the window closes (6 hours on the testnet). To find them: read the `ScoreProposed` logs of the last window and check the sender of each transaction; for each agent you can also read `getPendingScore(didHash)`, whose `proposer` field names who made the proposal. The checker's `GET /divergence` lists the ones it disagrees with.
4. **If no signer is named, watch for `initiateUnbond`.** If the thief starts it, the committee slashes the operator inside the 7 days.

## 2. Keep the evidence before anything is deleted

Do not run `down -v`, reboot, or recreate the container yet.

- `docker logs <container> > operator-<date>.log`. The testnet primary rotates container logs daily, so copy them now.
- Copy the state volume: `docker run --rm -v <project>_oracle_state:/data -v "$PWD":/out alpine tar czf /out/state-<date>.tgz -C /data .` (the checker's volume is `checker_state`).
- Write down: `/health` (commit), `docker ps`, `docker inspect <container>` (image, start time), `last -a`, `journalctl -u ssh --since "7 days ago"`, `ss -tnp`.
- Take a provider snapshot after the files are off the box (a new snapshot replaces the old one).

## 3. Rotate everything that lived on that box

Treat the box's `.env` as read. Change, in this order: the operator key (new wallet, see below), `ORACLE_ADMIN_TOKEN` and every `ORACLE_TOKEN_*` (tell the integrations), the Discord or Slack webhook, any RPC key, then every SSH key authorised on the host and every GitHub key stored on it. Hosts here are shared with other projects: say so to their owners.

## 4. Put an operator back

Follow `oracle/RUNBOOK-second-operator.md` steps 1 to 7 with a new wallet. It takes days (bond, admission, role). Until then there is one operator; say so in the status channel. Do not reuse the old address.

## 5. Afterwards

Write down how the key was exposed and what would have caught it earlier. If anything a user relied on changed, disclose it as `SECURITY.md` describes.

---

# Backing up and restoring `oracle_state`

Moved to [operations-runbook.md](operations-runbook.md#1-state-backup-and-restore), section 1: what the state file holds, the nightly off-box copy, restoring a live operator, and the quarterly restore drill.
