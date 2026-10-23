#!/bin/bash
# Deliberate breaks of the dispute judge and the lapsing slash. Each must fail a test. Run only after the
# change is committed: the restore uses git checkout.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p3-slash-results.txt}
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
  out=$(forge test --match-contract 'SigvaraStakingTest|DisputeFreezeTest' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=src/SigvaraStaking.sol
runl P1 $F 'function resolveDispute(bytes32 didHash, bool uphold)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'DEFAULT_ADMIN_ROLE' 'SLASHING_COMMITTEE_ROLE' 'the committee rules on disputes again'
runl P2 $F 'function resolveDispute(bytes32 didHash, bool uphold)' 'onlyRole(DEFAULT_ADMIN_ROLE)' 'onlyRole(DEFAULT_ADMIN_ROLE)' '' 'anyone can rule on a dispute'
runl P3 $F 'function expireSlash(bytes32 didHash)' 'if (block.timestamp <= expiresAt)' '<= expiresAt' '< expiresAt' 'a proposal lapses one second early'
runl P4 $F 'uint256 public constant EXECUTION_PERIOD' 'uint256 public constant EXECUTION_PERIOD' '14 days' '7 days' 'the execution period is a week'
runl P5 $F 'function expireSlash(bytes32 didHash)' 'uint256 expiresAt = proposal.challengeDeadline + EXECUTION_PERIOD;' 'proposal.challengeDeadline' 'proposal.initiatedAt' 'the period runs from filing and not from the deadline'
runl P6 $F 'function expireSlash(bytes32 didHash)' 'if (proposal.state != SlashState.Pending)' '!= SlashState.Pending' '== SlashState.None' 'any open proposal can be expired, a disputed one too'
runl P7 $F 'function expireSlash(bytes32 didHash)' '_dropProposal(didHash, proposal);' '_dropProposal(didHash, proposal);' 'proposal.state = SlashState.Cancelled;' 'a lapse marks the proposal cancelled but does not reinstate or start the cooldown'
runl P8 $F 'function expireSlash(bytes32 didHash)' 'function expireSlash(bytes32 didHash) external nonReentrant {' 'nonReentrant {' 'nonReentrant onlyRole(SLASHING_COMMITTEE_ROLE) {' 'only the committee can expire a proposal'
runl P9 $F 'function executeSlash(bytes32 didHash)' 'if (block.timestamp <= deadline) {' 'block.timestamp <= deadline' 'block.timestamp <= deadline || block.timestamp > deadline + EXECUTION_PERIOD' 'execution stops at the end of the execution period'
echo "DONE" >> "$OUT"
