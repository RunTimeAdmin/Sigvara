#!/bin/bash
# Deliberate breaks of the inflow pause. Each must fail a test: missing guards on the four inflows,
# a weakened pause, and guards that leak onto exits. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-guard-extra2-results.txt}
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
restore
ln=$(grep -n "whenInflowsOpen" src/SigvaraReputation.sol | sed -n 2p | cut -d: -f1)
sed -i "${ln}s/whenInflowsOpen//" src/SigvaraReputation.sol
out=$(forge test --match-contract InflowGuardTest 2>&1)
res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '
' ' ')
[ -z "$res" ] && res="SURVIVED (no test failed)"
echo "G19: proposeIfEmpty is not guarded (line $ln) => $res" >> "$OUT"
restore
echo "DONE" >> "$OUT"
