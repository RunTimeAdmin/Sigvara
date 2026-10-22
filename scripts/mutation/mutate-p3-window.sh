#!/bin/bash
# Deliberate breaks of the fixed review window. Each must fail a test. Run only after the change is committed.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p3-window-results.txt}
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
  out=$(forge test --match-contract 'SigvaraReputationTest' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=src/SigvaraReputation.sol
runl W1 $F 'function finalizeReputation(bytes32 didHash)' 'uint256 finalizableAt = _finalizableAt(pending);' '_finalizableAt(pending)' 'pending.proposedAt + challengeWindow' 'finalize reads the live window again'
runl W2 $F 'function rejectReputation(bytes32 didHash)' 'uint256 finalizableAt = _finalizableAt(pending);' '_finalizableAt(pending)' 'pending.proposedAt + challengeWindow' 'reject reads the live window again'
runl W3 $F 'pendingScores[didHash] = PendingScore({' 'finalizableAt:' 'block.timestamp + challengeWindow' '0' 'a proposal records no fixed end'
runl W4 $F 'pendingScores[didHash] = PendingScore({' 'finalizableAt:' 'block.timestamp + challengeWindow' 'block.timestamp' 'a proposal records a window of zero'
runl W5 $F 'function _finalizableAt(PendingScore storage pending)' 'if (at == 0)' 'if (at == 0) at = pending.proposedAt + challengeWindow;' '' 'a proposal from before the field existed has no fallback'
runl W6 $F 'function _finalizableAt(PendingScore storage pending)' 'if (at == 0)' 'pending.proposedAt + challengeWindow' 'block.timestamp + challengeWindow' 'the fallback counts from now and not from the proposal'
echo "DONE" >> "$OUT"
