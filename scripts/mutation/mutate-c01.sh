#!/bin/bash
# Deliberate breaks of the handover fix in SigvaraReputation.getTotalScore. Each must fail a test.
# Run only after the change is committed: files are restored with git checkout after every mutant.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-c01-results.txt}
: > "$OUT"
restore() { git checkout -- src test 2>/dev/null; }
trap restore EXIT

run() { # id, file, sed expression, what it breaks
  id=$1; file=$2; expr=$3; what=$4
  restore
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED (bad sed), $what" >> "$OUT"; return; fi
  res=$(forge test --match-contract SigvaraReputationTest --match-test 'test_maturity_' 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-120 | head -4 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}

F=src/SigvaraReputation.sol
run C1 $F 's/if (changed != 0 \&\& changed >= since) {/if (changed != 0 \&\& changed > since) {/' 'strict comparison again (the same-second sale is missed)'
run C2 $F 's/^                    anchor = 0;$//' 'the handover no longer clears the anchor'
run C3 $F 's/^                    since = changed;$//' 'the handover no longer restarts the clock'
run C4 $F 's/if (changed != 0 \&\& changed >= since) {/if (false) {/' 'the handover check is dead'
echo "DONE" >> "$OUT"
