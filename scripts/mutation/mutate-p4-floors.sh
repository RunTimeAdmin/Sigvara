#!/bin/bash
# Deliberate breaks of the mainnet launch floors. Each must fail a test. Run only against a committed tree.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-floors-results.txt}
: > "$OUT"
restore() { git checkout -- src test script 2>/dev/null; }
trap restore EXIT
runl() {
  id=$1; file=$2; anchor=$3; target=$4; from=$5; to=$6; what=$7
  restore
  a=$(grep -n -F -- "$anchor" "$file" | head -1 | cut -d: -f1)
  if [ -z "$a" ]; then echo "$id: ANCHOR NOT FOUND ($anchor), $what" >> "$OUT"; return; fi
  line=$(awk -v a="$a" -v t="$target" 'NR>=a && index($0,t) {print NR; exit}' "$file")
  if [ -z "$line" ]; then echo "$id: TARGET NOT FOUND ($target), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --match-contract 'DeployScript' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
D=script/Deploy.s.sol
O=script/DeployOracleBond.s.sol
runl D1 $D 'function _checkMainnetMinimumStake(' 'if (minStake < MAINNET_MINIMUM_STAKE)' 'minStake < MAINNET_MINIMUM_STAKE' 'false' 'a minimum stake under the target is accepted'
runl D2 $D 'function _checkMainnetMinimumStake(' 'if (minStake < MAINNET_MINIMUM_STAKE)' 'minStake < MAINNET_MINIMUM_STAKE' 'minStake <= MAINNET_MINIMUM_STAKE' 'the target itself is refused'
runl D3 $D 'uint256 constant MAINNET_MINIMUM_STAKE' 'uint256 constant MAINNET_MINIMUM_STAKE' '10_000e18' '9_999e18' 'the minimum stake target is one token short'
runl D4 $O 'function _checkMainnetBondAmount(' 'if (bondAmount < MAINNET_BOND_AMOUNT)' 'bondAmount < MAINNET_BOND_AMOUNT' 'false' 'a bond under the target is accepted'
runl D5 $O 'function _checkMainnetBondAmount(' 'if (bondAmount < MAINNET_BOND_AMOUNT)' 'bondAmount < MAINNET_BOND_AMOUNT' 'bondAmount <= MAINNET_BOND_AMOUNT' 'the bond target itself is refused'
runl D6 $O 'uint256 constant MAINNET_BOND_AMOUNT' 'uint256 constant MAINNET_BOND_AMOUNT' '2_500_000e18' '2_000_000e18' 'the bond target is two million'
runl D7 $D 'function _checkMainnetMinimumStake(' 'if (block.chainid != ARC_MAINNET) return;' '!= ARC_MAINNET' '== ARC_MAINNET' 'the minimum stake check runs on every chain but mainnet'
runl D8 $D 'function _checkMainnetMinimumStake(' 'if (minStake == DEFAULT_MINIMUM_STAKE)' 'minStake == DEFAULT_MINIMUM_STAKE' 'false' 'the default no longer gets its own error'
echo "DONE" >> "$OUT"
