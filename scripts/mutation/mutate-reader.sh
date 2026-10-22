#!/bin/bash
# Deliberate breaks of the Reader's collateral check. Each must fail a test. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-reader-results.txt}
: > "$OUT"
restore() { git checkout -- src test 2>/dev/null; }
trap restore EXIT
run() { # id, file, sed expression, what
  id=$1; file=$2; expr=$3; what=$4
  restore
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED (bad sed), $what" >> "$OUT"; return; fi
  res=$(forge test --match-contract 'SigvaraReaderTest|GatedMarketplaceTest|SmartWalletAgentTest' 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}
run R1 src/SigvaraReader.sol 's/^            \&\& staking.hasMinimumStake(didHash)$//' 'isTrusted does not ask about the bond'
run R2 src/SigvaraReader.sol 's/t.collateralized = staking.hasMinimumStake(didHash);/t.collateralized = true;/' 'the struct always says collateralized'
run R3 src/SigvaraReader.sol 's/t.collateralized = staking.hasMinimumStake(didHash);/t.collateralized = !staking.hasMinimumStake(didHash);/' 'the struct says the opposite'
echo "DONE" >> "$OUT"
