#!/bin/bash
# Deliberate breaks of the mainnet refusal in DeployEpochFees. Each must fail the end-to-end deploy
# test. Run only after the change is committed: the restore uses git checkout.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-epochfees-results.txt}
: > "$OUT"
restore() { git checkout -- src test script 2>/dev/null; }
trap restore EXIT
run() { # id, file, pattern (fixed string), sed from, sed to, what
  id=$1; file=$2; pat=$3; from=$4; to=$5; what=$6
  restore
  line=$(grep -n -F -- "$pat" "$file" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND ($pat), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --match-contract 'DeployScript' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=script/DeployEpochFees.s.sol
P='if (block.chainid == ARC_MAINNET) revert EpochFeesDeferredOnMainnet();'
run E1 $F "$P" 'if (block.chainid == ARC_MAINNET) revert EpochFeesDeferredOnMainnet();' '' 'the refusal is removed'
run E2 $F "$P" '== ARC_MAINNET' '!= ARC_MAINNET' 'the refusal applies everywhere but mainnet'
run E3 $F "$P" 'revert EpochFeesDeferredOnMainnet();' 'revert OperatorBondNotSet();' 'mainnet is refused with the wrong error'
echo "DONE" >> "$OUT"
