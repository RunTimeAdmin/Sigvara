# Mutation testing

A test suite that passes says nothing about whether it would fail if the code were wrong. These harnesses
check that. Each one applies a single deliberate break to the contracts or the scripts (a guard removed, a
comparison moved by one, a constant changed, a role swapped), runs the tests that are meant to cover that
change, records whether any test failed, and puts the tree back. A break that no test catches is a
mutant that survived: either a test is missing or the code it guarded does nothing. Every survivor so far
was a missing test, and was closed with one.

This is evidence for whoever reviews or audits the contracts, and a tool for whoever changes them. It is
not run in CI: one campaign is a few to thirty full compiles.

## Running one

Use a separate worktree, on a committed tree. The harness restores the files it mutates with
`git checkout -- src test script`, which also throws away any uncommitted work in those directories.

```bash
git worktree add ../sigvara-mutation HEAD
ln -s "$PWD/lib" ../sigvara-mutation/lib     # or install the dependencies there
REPO=../sigvara-mutation bash scripts/mutation/mutate-p4-ceilings.sh
cat "${TMPDIR:-/tmp}/mutate-p4-ceilings-results.txt"
```

`OUT` names the results file. Never run two harnesses on one tree at once, and do not edit the tree while
one runs. Each line of the results is one mutant:

| Line says | Means |
| --------- | ----- |
| `... => [FAIL ...` | a test failed, so the break was caught. The failing tests are named. |
| `SURVIVED (no test failed)` | no test noticed. Add one, then run it again. |
| `NO CHANGE APPLIED`, `ANCHOR NOT FOUND`, `TARGET NOT FOUND` | the pattern no longer matches the code, so nothing was tested. Fix the pattern. Never read this as a pass. |
| `COMPILE ERROR` | the break did not compile, so it tested nothing. |

## Writing a campaign

The newer campaigns share one helper, `runl id file anchor target from to what`: find the first line of
`file` containing `anchor`, then the first line at or after it containing `target`, and apply one `sed`
substitution `s/from/to/` on that line only. Finding the line by content and not by number keeps a campaign
valid when unrelated code moves. A `[` in `from` is a bracket expression in `sed`; escape it (`\[i\]`). The
older campaigns use an earlier form of the same idea (`run`), with the same reporting.

## Campaigns

Each was run against the pull request or range listed, when it was written, and every break was caught. They
apply to the code as it stood then. Re-run them on the commit that is going to be frozen, which is what
shows a pattern that has drifted (`NO CHANGE APPLIED`) and a test that has since gone.

| Campaign | Covers | Breaks | Caught |
| -------- | ------ | ------ | ------ |
| `mutate-pf.sh` | pre-freeze cleanups (PR 29) | 7 | 7 |
| `mutate-c01.sh` | operator handover resets maturity (PR 30) | 4 | 4 |
| `mutate-floors.sh` | floors enforced where values are set (PR 31) | 13 | 13 |
| `mutate-reader.sh` | Reader reports collateral (PR 32) | 3 | 3 |
| `mutate-slash.sh` | slash re-file cooldown, admin veto (PR 33) | 9 | 9 |
| `mutate-wiring.sh` | wiring behind the timelock (PR 34) | 2 | 2 |
| `mutate-guard.sh`, `-extra.sh`, `-extra2.sh` | inflow pause (PR 35) | 19 | 19 |
| `mutate-epochfees.sh` | epoch fees deferred (PR 36) | 3 | 3 |
| `mutate-p3-slash.sh` | admin rules disputes, lapsing slash (PR 38) | 9 | 9 |
| `mutate-p3-roles.sh` | fund-moving roles through the timelock (PR 39) | 11 | 11 |
| `mutate-p3-window.sh` | score window fixed at proposal (PR 40) | 6 | 6 |
| `mutate-p4-dispute.sh` | an upheld dispute waits for the deadline | 7 | 7 |
| `mutate-p4-payee.sh` | the slasher is never the payee | 10 | 10 |
| `mutate-p4-ceilings.sh` | ceilings on periods, window and rate | 27 | 27 |
| `mutate-p4-floors.sh` | mainnet launch floors | 8 | 8 |
| `mutate-p4-reader.sh` | score age on the Reader | 9 | 9 |
| `mutate-p4-handover.sh` | fail-closed renounce, upgrade shape check | 12 | 12 |

Survivors found and closed on the way: two exits that no test exercised while a pause was running
(`executeSlash` and `withdrawBond`) in the pause campaign, and a `_grantRole` that refused the slash
beneficiary every role, not only the slasher role, in the payee campaign. Each got a test, and the table
is the run after it.

What a clean campaign does not show: it covers the breaks someone thought of. It is a floor on how well the
suite notices a change to a guard, not a proof that the guards are right.
