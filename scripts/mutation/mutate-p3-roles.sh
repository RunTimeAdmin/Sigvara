#!/bin/bash
# Deliberate breaks of the timelocked grants. Each must fail a test. Run only after the change is committed:
# the restore uses git checkout.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p3-roles-results.txt}
: > "$OUT"
restore() { git checkout -- src test script 2>/dev/null; }
trap restore EXIT
# run id file pattern from to what: the first line holding the pattern gets one sed substitution
run() {
  id=$1; file=$2; pat=$3; from=$4; to=$5; what=$6
  restore
  line=$(grep -n -F -- "$pat" "$file" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND ($pat), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --match-contract 'TimelockedGrantsTest|UpgraderRoleAdminTest|SplitAuthorityTest' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
T=src/TimelockedGrants.sol
run R1 $T 'if (role != UPGRADER' 'hasRole(DEFAULT_ADMIN_ROLE, _msgSender())' 'false' 'the admin can no longer revoke a timelocked role at once'
run R2 $T 'if (role != UPGRADER' 'role != UPGRADER \&\& ' '' 'the admin can revoke the upgrader role'
run R3 $T 'if (role != UPGRADER' 'hasRole(DEFAULT_ADMIN_ROLE, _msgSender())' 'true' 'anyone can revoke a timelocked role'
run R4 src/SigvaraOracleBond.sol '_setRoleAdmin(SLASHER_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(SLASHER_ROLE, UPGRADER_ROLE);' '' 'the slasher role is granted by the admin again'
run R5 src/SigvaraStaking.sol '_setRoleAdmin(SLASHING_COMMITTEE_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(SLASHING_COMMITTEE_ROLE, UPGRADER_ROLE);' '' 'the committee role on staking is granted by the admin again'
run R6 src/SigvaraReputation.sol '_setRoleAdmin(SLASHING_COMMITTEE_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(SLASHING_COMMITTEE_ROLE, UPGRADER_ROLE);' '' 'the committee role on reputation is granted by the admin again'
run R7 src/SigvaraReputation.sol '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE);' '' 'the staking core role on reputation is granted by the admin again'
run R8 src/SigvaraIdentity.sol '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE);' '' 'the staking core role on identity is granted by the admin again'
run R9 src/SigvaraOracleBond.sol 'function setSlashBeneficiary(address newBeneficiary)' 'onlyRole(UPGRADER_ROLE)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'the admin can set the slash beneficiary again'
run R10 src/SigvaraOracleBond.sol 'function setSlashBeneficiary(address newBeneficiary)' 'onlyRole(UPGRADER_ROLE)' '' 'anyone can set the slash beneficiary'
run R11 src/SigvaraReputation.sol '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE);' '_setRoleAdmin(STAKING_CORE_ROLE, UPGRADER_ROLE)' '_setRoleAdmin(ORACLE_ROLE, UPGRADER_ROLE)' 'the oracle role is timelocked and the staking core role is not'
echo "DONE" >> "$OUT"
