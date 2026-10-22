#!/bin/bash
# Deliberate breaks of the inflow pause. Each must fail a test: missing guards on the four inflows,
# a weakened pause, and guards that leak onto exits. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-guard-results.txt}
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
run G1  src/SigvaraIdentity.sol   'whenInflowsOpen' ' *whenInflowsOpen' '' 'registerAgent is not guarded'
run G2  src/SigvaraStaking.sol    'depositStake(bytes32 didHash, uint256 amount) external nonReentrant whenInflowsOpen' ' whenInflowsOpen' '' 'depositStake is not guarded'
run G3  src/SigvaraReputation.sol 'whenInflowsOpen' ' *whenInflowsOpen' '' 'proposeReputation is not guarded'
run G4  src/SigvaraOracleBond.sol 'depositBond(uint256 amount) external nonReentrant whenInflowsOpen' ' whenInflowsOpen' '' 'depositBond is not guarded'
run G5  $G '_checkGuardian();' '_checkGuardian();' '' 'anyone can pause'
run G6  $G 'uint256 public constant PAUSE_DURATION = 3 days;' '3 days' '1 days' 'a pause lasts one day'
run G7  $G 'if (g.lastPausedAt != 0) {' 'g.lastPausedAt != 0' 'false' 'there is no cooldown'
run G8  $G 'uint256 availableAt = uint256(g.lastPausedAt) + PAUSE_DURATION + PAUSE_COOLDOWN;' ' + PAUSE_DURATION' '' 'the cooldown is counted from the start and not the end'
run G9  $G '_checkGuardianOrAdmin();' '_checkGuardianOrAdmin();' '' 'anyone can lift a pause'
run G10 $G 'g.pausedUntil = 0;' 'g.pausedUntil = 0;' 'g.pausedUntil = 0; g.lastPausedAt = 0;' 'lifting a pause also clears the cooldown'
run G11 $G '0x287c8fb15631f80ef6f31f6f05488520b9eeb2c6cd268d791bdb00597a165800' '0x287c8fb' '0x387c8fb' 'the storage slot constant is wrong'
run G12 src/SigvaraStaking.sol    'function initiateWithdrawal(bytes32 didHash, uint256 amount) external nonReentrant {' 'nonReentrant {' 'nonReentrant whenInflowsOpen {' 'a pause blocks starting a withdrawal'
run G13 src/SigvaraStaking.sol    'function claimWithdrawal(bytes32 didHash) external nonReentrant {' 'nonReentrant {' 'nonReentrant whenInflowsOpen {' 'a pause blocks claiming a withdrawal'
run G14 src/SigvaraStaking.sol    'function executeSlash(bytes32 didHash) external nonReentrant {' 'nonReentrant {' 'nonReentrant whenInflowsOpen {' 'a pause blocks executing a slash'
run G15 src/SigvaraReputation.sol 'function finalizeReputation(bytes32 didHash) external {' 'external {' 'external whenInflowsOpen {' 'a pause blocks finalizing a score'
run G16 src/SigvaraOracleBond.sol 'function withdrawBond() external nonReentrant {' 'nonReentrant {' 'nonReentrant whenInflowsOpen {' 'a pause blocks withdrawing a bond'
run G17 src/SigvaraIdentity.sol   'function acceptOperatorTransfer(bytes32 didHash) external {' 'external {' 'external whenInflowsOpen {' 'a pause blocks an operator transfer'
echo "DONE" >> "$OUT"
