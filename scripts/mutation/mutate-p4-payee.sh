#!/bin/bash
# Deliberate breaks of the rule that the slasher is never the payee. Each must fail a test. Run only against a
# committed tree: the restore uses git checkout. REPO defaults to the repository this script is in.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-payee-results.txt}
: > "$OUT"
restore() { git checkout -- src test script 2>/dev/null; }
trap restore EXIT
# runl id file anchor target from to what: find the anchor, then the first line at or after it that holds the
# target, and apply one sed substitution on that line only.
runl() {
  id=$1; file=$2; anchor=$3; target=$4; from=$5; to=$6; what=$7
  restore
  a=$(grep -n -F -- "$anchor" "$file" | head -1 | cut -d: -f1)
  if [ -z "$a" ]; then echo "$id: ANCHOR NOT FOUND ($anchor), $what" >> "$OUT"; return; fi
  line=$(awk -v a="$a" -v t="$target" 'NR>=a && index($0,t) {print NR; exit}' "$file")
  if [ -z "$line" ]; then echo "$id: TARGET NOT FOUND ($target), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --no-match-contract 'Invariant' --match-contract 'OracleBond|TimelockedGrants|DeployScriptGuards|SecurityFixes|UpgraderRoleAdmin|OperatorCustody|InflowGuard' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=src/SigvaraOracleBond.sol
S=script/DeployOracleBond.s.sol
runl B1 $F 'function initialize(' 'if (slasher == slashBeneficiary_) revert SlasherIsBeneficiary(slasher);' 'slasher == slashBeneficiary_' 'false' 'initialize accepts a slasher that is the beneficiary'
runl B2 $F 'function _grantRole(bytes32 role, address account)' 'if (role == SLASHER_ROLE && account == slashBeneficiary)' 'account == slashBeneficiary' 'false' 'a later grant of the slasher role to the beneficiary is accepted'
runl B3 $F 'function _grantRole(bytes32 role, address account)' 'if (role == SLASHER_ROLE && account == slashBeneficiary)' 'role == SLASHER_ROLE \&\& ' '' 'the beneficiary is refused every role, not just the slasher role'
runl B4 $F 'function _grantRole(bytes32 role, address account)' 'if (role == SLASHER_ROLE && account == slashBeneficiary)' 'role == SLASHER_ROLE' 'role == GUARDIAN_ROLE' 'the grant check watches the wrong role'
runl B5 $F 'function setSlashBeneficiary(address newBeneficiary)' 'if (hasRole(SLASHER_ROLE, newBeneficiary))' 'hasRole(SLASHER_ROLE, newBeneficiary)' 'false' 'naming a holder of the slasher role as beneficiary is accepted'
runl B6 $F 'function setSlashBeneficiary(address newBeneficiary)' 'if (hasRole(SLASHER_ROLE, newBeneficiary))' 'SLASHER_ROLE, newBeneficiary' 'GUARDIAN_ROLE, newBeneficiary' 'the beneficiary check looks at the wrong role'
runl B7 $F 'function initialize(' 'if (slasher == slashBeneficiary_) revert SlasherIsBeneficiary(slasher);' 'slasher == slashBeneficiary_' 'slasher == admin' 'initialize compares the slasher with the admin'
runl B8 $F 'function _grantRole(bytes32 role, address account)' 'return super._grantRole(role, account);' 'return super._grantRole(role, account);' 'return false;' 'the override never grants'
runl B9 $S 'function _checkRoleSeparation(' 'if (slasher == beneficiary) revert SlasherIsBeneficiary(slasher);' 'slasher == beneficiary' 'false' 'the deploy script no longer says it first'
runl B10 $S 'function _checkRoleSeparation(' 'if (slasher == beneficiary) revert SlasherIsBeneficiary(slasher);' 'if (slasher == beneficiary)' 'if (block.chainid == ARC_MAINNET \&\& slasher == beneficiary)' 'the deploy script checks only on mainnet'
echo "DONE" >> "$OUT"
