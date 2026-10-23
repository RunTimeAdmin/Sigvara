#!/bin/bash
# Deliberate breaks of the floors. Each must fail a test. Run only after the change is committed:
# files are restored with git checkout after every mutant, and again on exit.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-floors-results.txt}
: > "$OUT"
restore() { git checkout -- src script test 2>/dev/null; }
trap restore EXIT
CONTRACTS='SigvaraReputationTest|SigvaraOracleBondTest|SigvaraStakingTest|DeployScriptGuardsTest|DeployScriptRunTest'

# id, file, grep pattern, which match (1-based), sed from, sed to, what it breaks
run() {
  id=$1; file=$2; pat=$3; k=$4; from=$5; to=$6; what=$7
  restore
  line=$(grep -n -F -- "$pat" "$file" | sed -n "${k}p" | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND ($pat), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  res=$(forge test --match-contract "$CONTRACTS" 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}

R=src/SigvaraReputation.sol
B=src/SigvaraOracleBond.sol
S=src/SigvaraStaking.sol
run F1  $R 'if (challengeWindow_ < MIN_CHALLENGE_WINDOW) {' 1 'challengeWindow_ < MIN_CHALLENGE_WINDOW' 'false' 'reputation initialize has no window floor'
run F2  $R 'if (challengeWindow_ < MIN_CHALLENGE_WINDOW) {' 2 'challengeWindow_ < MIN_CHALLENGE_WINDOW' 'false' 'reputation initializeV2 has no window floor'
run F3  $R 'if (newWindow < MIN_CHALLENGE_WINDOW)' 1 'newWindow < MIN_CHALLENGE_WINDOW' 'false' 'setChallengeWindow has no floor'
run F4  $R 'if (newWindow < MIN_CHALLENGE_WINDOW)' 1 'newWindow < MIN_CHALLENGE_WINDOW' 'newWindow <= MIN_CHALLENGE_WINDOW' 'setChallengeWindow refuses the floor itself'
run F5  $B 'if (bondAmount_ == 0) revert ZeroAmount();' 1 'bondAmount_ == 0' 'false' 'bond registry initialize accepts a zero requirement'
run F6  $B 'if (unbondingPeriod_ < MIN_UNBONDING_PERIOD) {' 1 'unbondingPeriod_ < MIN_UNBONDING_PERIOD' 'false' 'bond registry initialize has no unbonding floor'
run F7  $B 'if (newPeriod < MIN_UNBONDING_PERIOD)' 1 'newPeriod < MIN_UNBONDING_PERIOD' 'false' 'bond registry setUnbondingPeriod has no floor'
run F8  $S 'if (minimumStake_ == 0) revert MinimumStakeZero();' 1 'minimumStake_ == 0' 'false' 'staking initialize accepts a zero minimum stake'
run F9  $S 'if (challengePeriod_ < MIN_CHALLENGE_PERIOD)' 1 'challengePeriod_ < MIN_CHALLENGE_PERIOD' 'false' 'staking initialize has no challenge floor'
run F10 $S 'if (unbondingPeriod_ < MIN_UNBONDING_PERIOD) revert PeriodTooShort(unbondingPeriod_, MIN_UNBONDING_PERIOD);' 1 'unbondingPeriod_ < MIN_UNBONDING_PERIOD' 'false' 'staking initialize has no unbonding floor'
run F11 $S 'if (newMinimum == 0) revert MinimumStakeZero();' 1 'newMinimum == 0' 'false' 'setMinimumStake accepts zero'
run F12 script/DeployOracleBond.s.sol '_checkMainnetUnbonding(unbonding);' 1 '_checkMainnetUnbonding(unbonding);' '' 'DeployOracleBond.run no longer checks the unbonding period'
run F13 script/Deploy.s.sol 'if (scoreWindow < MIN_CHALLENGE_WINDOW) {' 1 'scoreWindow < MIN_CHALLENGE_WINDOW' 'scoreWindow == 0' 'Deploy only refuses a zero score window'
echo "DONE" >> "$OUT"
