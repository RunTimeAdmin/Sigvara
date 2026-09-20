# Divergence log

Every disagreement the checking operator records, and what it turned out to be.

A checker that reports a disagreement and never says how it resolved is worse than no
checker. `/divergence` is an append-only record pruned by age, so a reader finds an
unexplained accusation against the primary and no outcome. This file is the outcome.

The rule: **every entry gets a verdict, including the ones that were the checker's own
fault.** A log that only contains vindicated findings is a marketing document.

Live endpoint: [`checker.sigvara.xyz/divergence`](https://checker.sigvara.xyz/divergence).

---

## 2026-09-20 · demo agent `0x8414ce0b…` · evidence skew, predicted in advance

**Status: prediction recorded 22:45Z, before the event. Outcome below once it happens.**

This entry is written before the divergence occurs, on purpose. A triage log whose
verdicts are all written after the fact proves only that the author can construct an
explanation. Committing the expectation first makes it falsifiable.

### What was done

Six independent payer wallets each paid the demo agent 500 SVR, and each settlement was
attested **to the primary oracle only**. The primary's live recomputation moved:

```
before   fee 0   success 4   tenure 0   community 5            total  9
after    fee 20  success 9   tenure 4   community 5            total 38
         distinctPayers 2 -> 8, activity window 3s -> ~2.4 days
```

### The prediction

At the primary's next epoch (~23:44Z) it should propose roughly **38**. The checker should
disagree, loudly, and be **wrong to the extent that it disagrees** — because it has not
been told about the six settlements.

Attestations arrive over HTTP, not from the chain. The transfers are on chain and the
checker scans the chain, but it scans for `AgentRegistered`, not for payments: a payment
enters the score only when someone attests it, carrying the settlement hash the oracle then
re-verifies. Six attestations went to the primary and none to the checker, so the checker
holds its two seeded payments and nothing else.

Expected, therefore:

| | primary | checker | why |
|---|---|---|---|
| fee | 20 | 0 | checker sees 23 SVR of volume, not 3,023 |
| success | 9 | ~4 | two attestations against nine |
| tenure | 4 | 0 | its window is still the original 3-second span |
| community | 5 | 5 | neither is flagged |
| **total** | **~38** | **~9** | a gap of roughly 29, far past the 3-point tolerance |

The watcher should then alert Discord with a `rejectReputation` instruction against a
primary that has done nothing wrong.

### What this is a test of

Not whether the checker detects disagreement — that is settled. Whether the *triage path*
works when the disagreement is large, real, and not the checker's cold start: whether the
cause is diagnosable from published data alone, and whether the outcome gets written down
rather than quietly seeded away.

**If the numbers come back materially different from the table above, the prediction was
wrong and that goes in this file too.**

### Outcome

*Pending. Expected ~23:44Z.*

---

## 2026-09-20 · demo agent `0x8414ce0b…` · pending 12, checker 10

**Verdict: not a scoring bug. Two separate causes, both understood, neither the
primary's fault.**

```
at          2026-09-20T20:31:56Z
proposedAt  1789925812  (17:36:52Z)
pendingTotal 12   ownTotal 10
factors     successScore  pending 7  own 0   delta -7
            ageScore      pending 0  own 5   delta +5
```

### Cause 1 — the checker was scoring from an empty state file

The checker's first epoch ran at 20:31:31, twenty-five seconds before the record, and its
own log says why:

```
[oracle] no prior state at /data/oracle-state.json, starting fresh
```

`paymentEvents` is the one part of oracle state a rescan cannot rebuild. Attestations
arrive over HTTP, not from the chain, so a fresh checker has none. That produces exactly
the two factors in the record:

- **`successScore` 0** — no attestations observed, so no success ratio to compute.
- **`ageScore` 5** — with no payment events there is no activity window, so tenure falls
  back to the calendar curve. The primary *has* the window (a three-second span between
  the agent's two payments) and correctly scores 0. The checker scoring *higher* here is
  the tell: it was not seeing less evidence and grading down, it was seeing none and
  taking a different code path.

Resolved by seeding the checker at 20:39 with the two settlement transactions the primary
had counted, re-verified against the chain by the checker itself rather than copied. Its
next epoch, 20:42:41, recorded no divergence.

This was an operator error, not a protocol one: the runbook said to seed the state and
did not say to do it *before* the first epoch. Fixed in `oracle/RUNBOOK-second-operator.md`
step 7a, which now also explains what it costs — with a watcher running, a cold-start
record pages someone with a `rejectReputation` instruction against a healthy primary.

### Cause 2 — the proposal predates the reweight

The audited proposal was made at 17:36:52, before the factor reweight was deployed. It
carries old-weight values (`successScore` 7 of a then-25-point factor). The checker,
running post-reweight code, computes 4 of a 15-point factor from the same evidence. Both
are correct for their moment.

That skew was structural and is now closed: the checker re-measures a pending proposal at
its own `proposedAt` before comparing, so it asks what the primary *should have computed
when it proposed*, not what the checker computes now. A divergence after that change means
the evidence disagreed.

### Why the record is still visible

It cannot be retracted. `/divergence` is append-only by design, because a committee
reviewing a disagreement needs its history and an operator who can delete entries is not
a check on anything. The entry ages out after 30 days. It stops being *actionable* — which
is what the watcher alerts on — as soon as that proposal turns over and the record
classifies as `superseded`.

### What this says about the checker

It worked. It disagreed with the primary within twenty-five seconds of starting, on its
first epoch, and the disagreement was real: the two processes genuinely computed different
numbers. That the cause was the checker's own empty state is the point of having a second
one — the failure was visible and diagnosable from published data rather than silent.

What it does not demonstrate is a checker catching a dishonest primary. Nothing has yet.
