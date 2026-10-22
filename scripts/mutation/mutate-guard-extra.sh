#!/bin/bash
# Deliberate breaks of the inflow pause. Each must fail a test: missing guards on the four inflows,
# a weakened pause, and guards that leak onto exits. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-guard-extra-results.txt}
: > "$OUT"
restore() { git checkout -- src test 2>/dev/null; }
trap restore EXIT
run() { # id, file, pattern (fixed string), sed from, sed to, what
  id=$1; file=$2; pat=$3; from=$4; to=$5; what=$6
  restore
  line=$(grep -n -F -- "$pat" "$file" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND ($pat), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --match-contract 'InflowGuardTest' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
G=src/InflowGuard.sol
run G18 src/SigvaraStaking.sol 'function cancelSlash(bytes32 didHash) external nonReentrant onlyRole(SLASHING_COMMITTEE_ROLE) {' 'COMMITTEE_ROLE) {' 'COMMITTEE_ROLE) whenInflowsOpen {' 'a pause blocks cancelling a slash'
echo "DONE" >> "$OUT"
