#!/bin/bash
# Deliberate breaks of the Reader's freshness. Each must fail a test. Run only against a committed tree.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-reader-results.txt}
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
  out=$(forge test --match-contract 'SigvaraReaderTest|GatedMarketplace|SmartWalletAgent' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
F=src/SigvaraReader.sol
runl E1 $F 'function isTrustedFresh(' 'return updatedAt != 0 && block.timestamp - updatedAt <= maxAgeSeconds;' 'block.timestamp - updatedAt <= maxAgeSeconds' 'true' 'the age is never checked'
runl E2 $F 'function isTrustedFresh(' 'return updatedAt != 0 && block.timestamp - updatedAt <= maxAgeSeconds;' '<= maxAgeSeconds' '< maxAgeSeconds' 'a score exactly as old as the limit is refused'
runl E3 $F 'function isTrustedFresh(' 'return updatedAt != 0 && block.timestamp - updatedAt <= maxAgeSeconds;' 'updatedAt != 0 \&\& ' '' 'an agent that was never scored is fresh'
runl E4 $F 'function isTrustedFresh(' 'if (!_isTrusted(didHash, minScore)) return false;' '!_isTrusted(didHash, minScore)' 'false' 'freshness stands in for trust instead of adding to it'
runl E5 $F 'function isTrustedFresh(' 'return updatedAt != 0 && block.timestamp - updatedAt <= maxAgeSeconds;' '<= maxAgeSeconds' '>= maxAgeSeconds' 'the age comparison is inverted'
runl E6 $F 'function _trust(' 't.scoreUpdatedAt = reputation.getReputation(didHash).lastUpdated;' 'reputation.getReputation(didHash).lastUpdated' 'block.timestamp' 'the struct reports now and not when the score was written'
runl E7 $F 'function _trust(' 't.scoreUpdatedAt = reputation.getReputation(didHash).lastUpdated;' 'reputation.getReputation(didHash).lastUpdated' '0' 'the struct reports no time'
runl E8 $F 'function _isTrusted(' 'return identity.isActive(didHash)' 'identity.isActive(didHash)' 'true' 'the shared check forgets status'
runl E9 $F 'function _isTrusted(' '&& staking.hasMinimumStake(didHash)' 'staking.hasMinimumStake(didHash)' 'true' 'the shared check forgets the bond'
echo "DONE" >> "$OUT"
