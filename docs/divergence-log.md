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

**Status: prediction recorded 22:45Z, before the event. Confirmed 23:51:23Z, every
number as predicted. Outcome below.**

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

**Verdict: attestation fan-out gap. The primary was right, the checker was right to
complain, and nothing was wrong with either. The prediction held on every number.**

The primary finalized the stale 12 and proposed at 23:44:10Z. The checker audited at
23:51:23Z and recorded:

```
at            2026-09-20T23:51:23Z
proposedAt    1789947850  (23:44:10Z)
pendingTotal  38    ownTotal 9
factors       feeScore      pending 20  own 0  delta -20
              successScore  pending  9  own 4  delta  -5
              ageScore      pending  4  own 0  delta  -4
evidence      ownEvidenceRoot       0xb07cdf…   ownPaymentEvents 2
              proposedEvidenceRoot  0xd4a95f…   ownDistinctPayers 2
```

Predicted against actual:

| | predicted | actual |
|---|---|---|
| fee | 20 / 0 | 20 / 0 |
| success | 9 / ~4 | 9 / 4 |
| tenure | 4 / 0 | 4 / 0 |
| community | 5 / 5 | 5 / 5 |
| total | ~38 / ~9 | **38 / 9** |
| gap | ~29 | **29** |

Nothing in the table moved. That is a weaker result than it looks: the prediction was made
with knowledge of both oracles' inputs, so it tested whether the scoring path is
deterministic and whether the triage path is usable, not whether anything was hard to
foresee.

### How it was triaged, entirely from published data

This is the part that was actually in question.

```
primary   8 payments   root 0xd4a95f…
checker   2 payments   root 0xb07cdf…
only primary has   6   (500 SVR each, six distinct payers, 22:43–22:44Z)
only checker has   0
```

Three of the six were verified against the chain directly: real transactions, sent by
exactly the attested payers, 500 SVR to the agent, status success. The primary was
counting genuine payments. The checker was never told about them, because attestations
arrive over HTTP and all six went to the primary only.

The Merkle structure settles the question that the diff alone cannot, which is whether
the primary *added* evidence or *rewrote* it:

- the checker's root `0xb07cdf…` appears in the proofs of 2 of the primary's 8 leaves,
  so it is an internal node of the primary's tree;
- recomputing `keccak(sorted(leaf1, leaf2))` from the checker's own two leaves reproduces
  `0xb07cdf…` exactly;
- both of the checker's leaves are still present, unchanged, in the primary's set.

The primary's evidence is the checker's plus six additions, with the older leaves
committed unchanged. A primary that had dropped or altered an earlier payment could not
produce a tree containing the old subtree root. None of that requires trusting either
operator: it is arithmetic over published data.

### What the exercise actually found

Not a scoring bug. A documentation bug, and a real one.

Step 3 of the triage procedure, the step that decides whose fault a divergence is, told
the reader to fetch `/evidence/<didHash>` from **both** oracles and diff the payment
lists. The checker did not publish `/evidence`. Worse, §11 of the same runbook asserted
that it **must** return 404, and the vhost implemented that faithfully. One section
required a path another section required to be absent.

So for the entire life of the checker, its disagreement was visible and its reasoning was
not. The primary's evidence was public; the checker's was not. A reader could see an
accusation against the primary and had no way to check it without a shell on the checker's
host. For a component whose whole purpose is to remove the need to trust one operator,
that is close to the opposite of the intent.

Fixed by publishing `/evidence/` on the checker (read-only GET, nothing in it secret,
every field either on chain or already published by the primary at the same path). The
§11 surface check now asserts `/evidence/0x00` returns **400** rather than 404: a
malformed didHash is rejected by the service, so 400 proves the request reached it, while
404 would pass whether or not the endpoint existed. The old assertion tested nothing.

Two smaller things the exercise surfaced:

- The first version of the diff command wrote both lists to files and compared them.
  With `jq` absent, both files came out empty and `diff` reported no difference, which
  reads as *the two oracles agree*. Agreement is the conclusion that ends an
  investigation, so that is the worst available failure mode. The step now checks both
  lists are non-empty before comparing.
- `PendingScore` nests `ReputationData`, which is seven fields rather than six, so
  `proposedAt` is word index 7. `lastUpdated` sits at index 6 and on a live proposal
  currently holds the same value, so reading the wrong word returns the right answer and
  the mistake stays hidden until it does not.

### Resolution

Seeded at 00:14Z with the six missing settlements, re-verified against the chain by the
checker itself rather than copied from the primary. Both oracles then computed the same
evidence root independently:

```
primary  8 payments  0xd4a95fc0559b4118…
checker  8 payments  0xd4a95fc0559b4118…   identical
```

txHashes, amounts and `settledAt` all match, the last of those re-read from the blocks by
each oracle separately rather than taken on the primary's word.

The checker's next epoch, 00:17:31Z, reported `0 proposed, 0 finalized, 0 diverged`. It
agrees.

**The 23:51 record does not go away, and the watcher does not know any of this.** The log
is append-only, so a checker cannot retract an opinion it has since revised. The disputed
proposal's window runs to 05:44:10Z and the primary will not turn it over before then
(its 00:44 epoch sees a pending score inside the window and skips), so until then the
record still classifies as `actionable`: a live alert, with remediation steps, against a
primary that did nothing wrong. The runbook warns about exactly this and the warning was
accurate.

That is the cost of seeding late rather than before the first epoch. It is bounded by one
proposal's lifetime, and it is the second time this has happened.

### Still not demonstrated

A checker catching a dishonest primary. Two divergences now, both benign, both the
checker's own missing evidence. The failure mode a second operator exists to catch has
not occurred, and a log of benign findings is not evidence that the mechanism works
against an adversary.

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
