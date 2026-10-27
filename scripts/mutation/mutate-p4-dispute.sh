#!/bin/bash
# Deliberate breaks of the gate on an upheld dispute ruling. Each must fail a test. Run only against a
# committed tree: the restore uses git checkout. REPO defaults to the repository this script is in.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-dispute-results.txt}
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
  out=$(forge test --match-test 'resolveDispute|slashingAndWithdrawing' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=src/SigvaraStaking.sol
A='function resolveDispute(bytes32 didHash, bool uphold)'
G='if (block.timestamp <= deadline) revert ChallengePeriodActive(didHash, deadline);'
D='uint256 deadline = proposal.challengeDeadline;'
runl A1 $F "$A" "$G" 'block.timestamp <= deadline' 'false' 'the gate is gone, so an uphold lands in the block of the dispute'
runl A2 $F "$A" "$G" '<= deadline' '< deadline' 'the gate opens at the deadline and not one second after'
runl A3 $F "$A" "$G" 'block.timestamp <= deadline' 'block.timestamp >= deadline' 'the gate is inverted'
runl A4 $F "$A" "$D" 'proposal.challengeDeadline' 'proposal.initiatedAt + challengePeriod' 'the gate reads the live period and not the snapshot'
runl A5 $F "$A" "$D" 'proposal.challengeDeadline' 'proposal.disputedAt + challengePeriod' 'the gate counts from the dispute and not from the filing'
runl A6 $F "$A" "$D" 'proposal.challengeDeadline' 'proposal.initiatedAt' 'the gate counts from the filing with no period at all'
runl A7 $F "$A" 'revert SlashNotDisputed(didHash);' 'revert SlashNotDisputed(didHash);' 'revert SlashNotDisputed(didHash); if (block.timestamp <= proposal.challengeDeadline) revert ChallengePeriodActive(didHash, proposal.challengeDeadline);' 'the gate also holds back a drop'
# The other end of an upheld ruling: it stops where the dispute can be expired, so an uphold and an expiry never overlap.
X='if (block.timestamp > expiresAt) revert DisputeResolutionExpired(didHash, expiresAt);'
E='uint256 expiresAt = proposal.disputedAt + DISPUTE_RESOLUTION_PERIOD;'
runl B1 $F "$A" "$X" 'block.timestamp > expiresAt' 'false' 'the bound is gone, so a late uphold still lands after the dispute can be expired'
runl B2 $F "$A" "$X" '> expiresAt' '>= expiresAt' 'the bound closes at the last second expireDispute still refuses'
runl B3 $F "$A" "$X" 'block.timestamp > expiresAt' 'block.timestamp < expiresAt' 'the bound is inverted'
runl B4 $F "$A" "$E" 'proposal.disputedAt + DISPUTE_RESOLUTION_PERIOD' 'proposal.challengeDeadline + DISPUTE_RESOLUTION_PERIOD' 'the bound counts from the deadline and not from the dispute'
echo "DONE" >> "$OUT"
