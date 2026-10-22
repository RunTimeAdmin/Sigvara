#!/bin/bash
# Deliberate breaks of the slash re-file cooldown and the admin veto. Each must fail a test.
# Run only after the change is committed: files are restored with git checkout after every mutant.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-slash-results.txt}
: > "$OUT"
restore() { git checkout -- src test 2>/dev/null; }
trap restore EXIT
S=src/SigvaraStaking.sol
CONTRACTS='SigvaraStakingTest|DisputeFreezeTest'

# sed on the first line matching a fixed pattern
run() { # id, pattern, sed from, sed to, what
  id=$1; pat=$2; from=$3; to=$4; what=$5
  restore
  line=$(grep -n -F -- "$pat" "$S" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND ($pat), $what" >> "$OUT"; return; fi
  sed -i "${line}s/${from}/${to}/" "$S"
  if git diff --quiet -- "$S"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  res=$(forge test --match-contract "$CONTRACTS" 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}

# delete the first line matching `target` that comes after the line matching `header`
run_delete_after() { # id, header, target, what
  id=$1; header=$2; target=$3; what=$4
  restore
  h=$(grep -n -F -- "$header" "$S" | head -1 | cut -d: -f1)
  line=$(awk -v h="$h" -v t="$target" 'NR>h && index($0,t) {print NR; exit}' "$S")
  if [ -z "$h" ] || [ -z "$line" ]; then echo "$id: PATTERN NOT FOUND, $what" >> "$OUT"; return; fi
  sed -i "${line}d" "$S"
  res=$(forge test --match-contract "$CONTRACTS" 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}

run S1 'if (droppedAt != 0 && block.timestamp < droppedAt + challengePeriod) {' 'droppedAt != 0 \&\& block.timestamp < droppedAt + challengePeriod' 'false' 'no re-file cooldown'
run S2 'if (droppedAt != 0 && block.timestamp < droppedAt + challengePeriod) {' 'block.timestamp < droppedAt + challengePeriod' 'block.timestamp <= droppedAt + challengePeriod' 'the cooldown lasts one second too long'
run S3 'lastDroppedAt[didHash] = block.timestamp;' 'lastDroppedAt\[didHash\] = block.timestamp;' '' 'a dropped proposal is not recorded'
run S4 'if (droppedAt != 0 && block.timestamp < droppedAt + challengePeriod) {' 'block.timestamp < droppedAt + challengePeriod' 'block.timestamp < droppedAt' 'the cooldown is zero length'
run S5 'function vetoSlash(bytes32 didHash)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'onlyRole(SLASHING_COMMITTEE_ROLE)' 'the committee holds the veto'
run S6 'if (proposal.state != SlashState.Pending && proposal.state != SlashState.Disputed) {' 'proposal.state != SlashState.Pending \&\& proposal.state != SlashState.Disputed' 'proposal.state != SlashState.Pending' 'the veto ignores a disputed proposal'
run S7 'if (proposal.state != SlashState.Pending && proposal.state != SlashState.Disputed) {' 'proposal.state != SlashState.Pending \&\& proposal.state != SlashState.Disputed' 'proposal.state == SlashState.None' 'the veto accepts an executed proposal'
run_delete_after S8 'function vetoSlash(bytes32 didHash)' '_dropProposal(didHash, proposal);' 'the veto does not drop the proposal'
run_delete_after S9 'function vetoSlash(bytes32 didHash)' 'emit SlashVetoed(didHash, msg.sender);' 'the veto does not announce itself'
echo "DONE" >> "$OUT"
