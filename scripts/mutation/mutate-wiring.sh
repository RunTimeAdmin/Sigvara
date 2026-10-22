#!/bin/bash
# Deliberate breaks of the timelocked wiring setters. Each must fail a test. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-wiring-results.txt}
: > "$OUT"
restore() { git checkout -- src test 2>/dev/null; }
trap restore EXIT
run() { # id, file, pattern, sed from, sed to, what
  id=$1; file=$2; pat=$3; from=$4; to=$5; what=$6
  restore
  line=$(grep -n -F -- "$pat" "$file" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND, $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  res=$(forge test --match-contract 'SigvaraIdentityTest|SigvaraReputationTest|SplitAuthorityTest' 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}
run W1 src/SigvaraIdentity.sol 'function setStakeView(address stakeView_) external onlyRole(UPGRADER_ROLE) {' 'onlyRole(UPGRADER_ROLE)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'setStakeView is back on the admin role'
run W2 src/SigvaraReputation.sol 'function setOperatorBond(address operatorBond_) external onlyRole(UPGRADER_ROLE) {' 'onlyRole(UPGRADER_ROLE)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'setOperatorBond is back on the admin role'
echo "DONE" >> "$OUT"
