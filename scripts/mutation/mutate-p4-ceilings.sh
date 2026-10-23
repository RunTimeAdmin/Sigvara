#!/bin/bash
# Deliberate breaks of the parameter ceilings. Each must fail a test. Run only against a committed tree: the
# restore uses git checkout. REPO defaults to the repository this script is in.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-ceilings-results.txt}
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
  out=$(forge test --match-contract 'SigvaraStakingTest|SigvaraReputationTest|SigvaraOracleBondTest|DeployScript' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
R=src/SigvaraReputation.sol
S=src/SigvaraStaking.sol
B=src/SigvaraOracleBond.sol
D=script/Deploy.s.sol
O=script/DeployOracleBond.s.sol
runl C1  $R 'function initialize(' 'if (challengeWindow_ > MAX_CHALLENGE_WINDOW) {' 'challengeWindow_ > MAX_CHALLENGE_WINDOW' 'false' 'reputation initialize takes any window'
runl C2  $R 'function initializeV2(address slashingCommittee' 'if (challengeWindow_ > MAX_CHALLENGE_WINDOW) {' 'challengeWindow_ > MAX_CHALLENGE_WINDOW' 'false' 'reputation initializeV2 takes any window'
runl C3  $R 'function setChallengeWindow(uint256 newWindow)' 'if (newWindow > MAX_CHALLENGE_WINDOW)' 'newWindow > MAX_CHALLENGE_WINDOW' 'false' 'setChallengeWindow takes any window'
runl C4  $R 'function setChallengeWindow(uint256 newWindow)' 'if (newWindow > MAX_CHALLENGE_WINDOW)' 'newWindow > MAX_CHALLENGE_WINDOW' 'newWindow >= MAX_CHALLENGE_WINDOW' 'setChallengeWindow refuses the ceiling itself'
runl C5  $R 'function initializeV4(uint256 pointsPerDay)' 'if (pointsPerDay > MAX_MATURITY_RATE_PER_DAY) {' 'pointsPerDay > MAX_MATURITY_RATE_PER_DAY' 'false' 'initializeV4 takes any rate'
runl C6  $R 'function setMaturityRate(uint256 pointsPerDay)' 'if (pointsPerDay > MAX_MATURITY_RATE_PER_DAY) {' 'pointsPerDay > MAX_MATURITY_RATE_PER_DAY' 'false' 'setMaturityRate takes any rate'
runl C7  $R 'function setMaturityRate(uint256 pointsPerDay)' 'if (pointsPerDay > MAX_MATURITY_RATE_PER_DAY) {' 'pointsPerDay > MAX_MATURITY_RATE_PER_DAY' 'pointsPerDay >= MAX_MATURITY_RATE_PER_DAY' 'setMaturityRate refuses the ceiling itself'
runl C8  $R 'uint256 public constant MAX_MATURITY_RATE_PER_DAY' 'uint256 public constant MAX_MATURITY_RATE_PER_DAY' '= 100;' '= 101;' 'the rate ceiling is 101'
runl C9  $R 'uint256 public constant MAX_CHALLENGE_WINDOW' 'uint256 public constant MAX_CHALLENGE_WINDOW' '7 days' '8 days' 'the window ceiling is 8 days'
runl C10 $S 'function initialize(' 'if (challengePeriod_ > MAX_CHALLENGE_PERIOD)' 'challengePeriod_ > MAX_CHALLENGE_PERIOD' 'false' 'staking initialize takes any challenge period'
runl C11 $S 'function initialize(' 'if (unbondingPeriod_ > MAX_UNBONDING_PERIOD)' 'unbondingPeriod_ > MAX_UNBONDING_PERIOD' 'false' 'staking initialize takes any unbonding period'
runl C12 $S 'function initializeV2(uint256 unbondingPeriod_)' 'if (unbondingPeriod_ > MAX_UNBONDING_PERIOD)' 'unbondingPeriod_ > MAX_UNBONDING_PERIOD' 'false' 'staking initializeV2 takes any unbonding period'
runl C13 $S 'function setChallengePeriod(uint256 newPeriod)' 'if (newPeriod > MAX_CHALLENGE_PERIOD)' 'newPeriod > MAX_CHALLENGE_PERIOD' 'false' 'setChallengePeriod takes any period'
runl C14 $S 'function setUnbondingPeriod(uint256 newPeriod)' 'if (newPeriod > MAX_UNBONDING_PERIOD)' 'newPeriod > MAX_UNBONDING_PERIOD' 'false' 'staking setUnbondingPeriod takes any period'
runl C15 $S 'function setUnbondingPeriod(uint256 newPeriod)' 'if (newPeriod > MAX_UNBONDING_PERIOD)' 'newPeriod > MAX_UNBONDING_PERIOD' 'newPeriod >= MAX_UNBONDING_PERIOD' 'staking setUnbondingPeriod refuses the ceiling itself'
runl C16 $S 'uint256 public constant MAX_CHALLENGE_PERIOD' 'uint256 public constant MAX_CHALLENGE_PERIOD' '30 days' '31 days' 'the challenge ceiling is 31 days'
runl C17 $S 'uint256 public constant MAX_UNBONDING_PERIOD' 'uint256 public constant MAX_UNBONDING_PERIOD' '90 days' '91 days' 'the staking unbonding ceiling is 91 days'
runl C18 $B 'function initialize(' 'if (unbondingPeriod_ > MAX_UNBONDING_PERIOD) {' 'unbondingPeriod_ > MAX_UNBONDING_PERIOD' 'false' 'bond initialize takes any unbonding period'
runl C19 $B 'function setUnbondingPeriod(uint256 newPeriod)' 'if (newPeriod > MAX_UNBONDING_PERIOD)' 'newPeriod > MAX_UNBONDING_PERIOD' 'false' 'bond setUnbondingPeriod takes any period'
runl C20 $B 'uint256 public constant MAX_UNBONDING_PERIOD' 'uint256 public constant MAX_UNBONDING_PERIOD' '90 days' '91 days' 'the bond unbonding ceiling is 91 days'
runl C21 $D 'function _checkMainnetPeriods(' 'if (period > MAX_CHALLENGE_PERIOD)' 'period > MAX_CHALLENGE_PERIOD' 'false' 'the script lets a challenge period above the ceiling through'
runl C22 $D 'function _checkMainnetPeriods(' 'if (unbondPeriod > MAX_UNBONDING_PERIOD) {' 'unbondPeriod > MAX_UNBONDING_PERIOD' 'false' 'the script lets an unbonding period above the ceiling through'
runl C23 $D 'function _checkMainnetPeriods(' 'if (scoreWindow > MAX_CHALLENGE_WINDOW) {' 'scoreWindow > MAX_CHALLENGE_WINDOW' 'false' 'the script lets a score window above the ceiling through'
runl C24 $D 'function _checkMainnetMaturityRate(' 'if (rate > MAX_MATURITY_RATE_PER_DAY)' 'rate > MAX_MATURITY_RATE_PER_DAY' 'false' 'the script lets a maturity rate above the ceiling through'
runl C25 $O 'function _checkMainnetUnbonding(' 'if (unbonding > MAX_UNBONDING)' 'unbonding > MAX_UNBONDING' 'false' 'the bond script lets an unbonding period above the ceiling through'
runl C26 $D 'uint256 constant MAX_UNBONDING_PERIOD' 'uint256 constant MAX_UNBONDING_PERIOD' '90 days' '91 days' 'the script copy of a ceiling drifts from the contract'
runl C27 $D 'function _checkMainnetPeriods(' 'if (period > MAX_CHALLENGE_PERIOD)' 'period > MAX_CHALLENGE_PERIOD' 'period >= MAX_CHALLENGE_PERIOD' 'the script refuses the ceiling itself'
echo "DONE" >> "$OUT"
