#!/bin/bash
# Deliberate breaks of SigvaraReputation and SigvaraEpochFees, run against the invariant suites alone. Each must
# fail an invariant, except the two marked as expected survivors: the point is what the invariants notice without
# the unit tests behind them. Run only against a committed tree: the restore uses git checkout. REPO defaults to
# the repository this script is in.
#
# A full compile of this repository takes minutes, and this campaign compiles once per break. For speed, point
# REPO at a small git repository holding src/, test/helpers, the two invariant test files, foundry.toml and a
# lib link, with an empty script/ directory tracked by a placeholder file.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-invariants-results.txt}
: > "$OUT"
restore() { git checkout -- src test script 2>/dev/null; }
trap restore EXIT
# runl id suite file anchor target from to what: find the anchor, then the first line at or after it that holds
# the target, and apply one sed substitution on that line only. `suite` names the invariant test contract that has
# to catch it. The substitution is delimited by # so that / can appear in it, and a . matches the [ and ] of an
# index expression, which sed would otherwise read as a bracket expression.
runl() {
  id=$1; suite=$2; file=$3; anchor=$4; target=$5; from=$6; to=$7; what=$8
  # ONLY="R2 E9" runs just those breaks, to try a fix to a test without the whole campaign.
  if [ -n "$ONLY" ] && ! echo " $ONLY " | grep -q " $id "; then return; fi
  restore
  a=$(grep -n -F -- "$anchor" "$file" | head -1 | cut -d: -f1)
  if [ -z "$a" ]; then echo "$id: ANCHOR NOT FOUND ($anchor), $what" >> "$OUT"; return; fi
  line=$(awk -v a="$a" -v t="$target" 'NR>=a && index($0,t) {print NR; exit}' "$file")
  if [ -z "$line" ]; then echo "$id: TARGET NOT FOUND ($target), $what" >> "$OUT"; return; fi
  sed -i "${line}s#${from}#${to}#" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED, $what" >> "$OUT"; return; fi
  out=$(forge test --fail-fast --match-contract "$suite" --match-test 'invariant_' 2>&1)
  res=$(echo "$out" | grep -E "^\[FAIL" | cut -c1-110 | head -2 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no invariant failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
R=src/SigvaraReputation.sol
F=src/SigvaraEpochFees.sol
RS=ReputationInvariantTest
FS=EpochFeesInvariantTest

# ---- SigvaraReputation: what may be proposed, and by whom --------------------------------------------------------
runl R1  $RS $R 'function _propose(' 'if (data.feeScore > MAX_FEE_SCORE)' 'data.feeScore > MAX_FEE_SCORE' 'false' 'the fee cap is not enforced'
runl R2  $RS $R 'function _propose(' 'if (data.ageScore > MAX_AGE_SCORE)' 'data.ageScore > MAX_AGE_SCORE' 'data.ageScore > MAX_AGE_SCORE + 1' 'the age cap is enforced one point late'
runl R3  $RS $R 'function _propose(' 'if (data.externalScore > MAX_EXTERNAL_SCORE)' 'data.externalScore > MAX_EXTERNAL_SCORE' 'false' 'the external cap is not enforced'
runl R4  $RS $R 'function _propose(' 'if (data.propagationScore > MAX_PROPAGATION_SCORE)' 'data.propagationScore > MAX_PROPAGATION_SCORE' 'data.propagationScore >= MAX_PROPAGATION_SCORE' 'a propagation score at its cap is refused'
runl R5  $RS $R 'uint8 public constant MAX_COMMUNITY_SCORE' 'uint8 public constant MAX_COMMUNITY_SCORE' '= 5;' '= 6;' 'the community cap is 6'
runl R6  $RS $R 'function _propose(' '_requireScorable(didHash);' '_requireScorable(didHash);' '' 'a proposal is not checked against the agent'
runl R7  $RS $R 'function _propose(' '_requireBondedOracle();' '_requireBondedOracle();' '' 'a proposal is not checked against the bonded operator set'
# R8 and R10 are expected survivors. A slash zeroes the stake and a slashed agent cannot bond again, and a hash nobody
# registered holds no stake, so the bond check refuses the same proposals and only the name of the error differs. The
# invariants check what is refused, not why; E2E.t.sol and SigvaraReputation.t.sol pin the names.
runl R8  $RS $R 'function _requireScorable(' 'if (id.status == SigvaraIdentity.AgentStatus.Slashed)' 'id.status == SigvaraIdentity.AgentStatus.Slashed' 'false' 'a slashed agent can be scored'
runl R9  $RS $R 'function _requireScorable(' 'if (!stakeView.hasMinimumStake(didHash))' '!stakeView.hasMinimumStake(didHash)' 'false' 'an unbonded agent can be scored'
runl R10 $RS $R 'function _requireScorable(' 'if (id.registeredAt == 0)' 'id.registeredAt == 0' 'false' 'an unregistered hash can be scored'
runl R11 $RS $R 'function proposeReputation(' 'onlyRole(ORACLE_ROLE)' 'onlyRole(ORACLE_ROLE)' '' 'anyone can propose'
runl R12 $RS $R 'function proposeReputation(' 'whenInflowsOpen' 'whenInflowsOpen' '' 'a pause does not stop proposals'
runl R13 $RS $R 'function proposeIfEmpty(' 'if (existing.exists && _proposerStillAuthorized(existing.proposer))' '_proposerStillAuthorized(existing.proposer)' 'false' 'proposeIfEmpty replaces a live proposal'
runl R14 $RS $R 'function proposeIfEmpty(' 'if (existing.exists && _proposerStillAuthorized(existing.proposer))' 'existing.exists && _proposerStillAuthorized(existing.proposer)' 'existing.exists' 'proposeIfEmpty is blocked by a proposal nobody can finalize'

# ---- SigvaraReputation: what a proposal records ------------------------------------------------------------------
runl R15 $RS $R 'function _propose(' 'finalizableAt: block.timestamp + challengeWindow' 'block.timestamp + challengeWindow' 'block.timestamp' 'a proposal is finalizable the moment it is made'
runl R16 $RS $R 'function _propose(' 'proposer: msg.sender' 'msg.sender' 'address(0)' 'a proposal does not remember its proposer'
runl R17 $RS $R 'function _propose(' 'evidenceRoot: evidenceRoot' 'evidenceRoot: evidenceRoot' 'evidenceRoot: bytes32(0)' 'a proposal drops its evidence root'
runl R18 $RS $R 'function _finalizableAt(' 'at = pending.finalizableAt;' 'pending.finalizableAt' 'pending.proposedAt + challengeWindow' 'the review window is read live, not as it stood at the proposal'

# ---- SigvaraReputation: finalizing, rejecting, zeroing -----------------------------------------------------------
runl R19 $RS $R 'function finalizeReputation(' 'if (block.timestamp < finalizableAt)' 'block.timestamp < finalizableAt' 'false' 'a proposal finalizes inside its window'
runl R20 $RS $R 'function finalizeReputation(' 'if (!_proposerStillAuthorized(pending.proposer))' '!_proposerStillAuthorized(pending.proposer)' 'false' 'a proposal finalizes after its proposer lost authority'
runl R21 $RS $R 'function finalizeReputation(' '_requireScorable(didHash);' '_requireScorable(didHash);' '' 'finalize does not recheck the agent'
runl R22 $RS $R 'function finalizeReputation(' 'uint8 anchor = getTotalScore(didHash);' 'getTotalScore' 'getEarnedScore' 'the anchor is the earned score, not the spendable one'
runl R23 $RS $R 'function finalizeReputation(' 'maturedAt[didHash] = block.timestamp;' 'maturedAt.didHash. = block.timestamp;' '' 'finalize does not restart the maturity clock'
runl R24 $RS $R 'function finalizeReputation(' 'maturedScore[didHash] = anchor;' 'maturedScore.didHash. = anchor;' '' 'finalize does not store the anchor'
runl R25 $RS $R 'function finalizeReputation(' 'data.lastUpdated = block.timestamp;' 'data.lastUpdated = block.timestamp;' '' 'finalize keeps the date the proposer sent'
runl R26 $RS $R 'function finalizeReputation(' 'delete pendingScores[didHash];' 'delete pendingScores.didHash.;' '' 'a finalized proposal stays pending'
runl R27 $RS $R 'function finalizeReputation(' 'evidenceRoots[didHash] = root;' 'evidenceRoots.didHash. = root;' '' 'finalize does not store the evidence root'
runl R28 $RS $R 'function rejectReputation(' 'if (block.timestamp >= finalizableAt)' 'block.timestamp >= finalizableAt' 'false' 'a proposal can be rejected after its window'
runl R29 $RS $R 'function rejectReputation(' 'onlyRole(SLASHING_COMMITTEE_ROLE)' 'onlyRole(SLASHING_COMMITTEE_ROLE)' '' 'anyone can reject a proposal'
runl R30 $RS $R 'function rejectReputation(' 'delete pendingScores[didHash];' 'delete pendingScores.didHash.;' '' 'a rejected proposal stays pending'
runl R31 $RS $R 'function zeroReputation(' 'delete pendingScores[didHash];' 'delete pendingScores.didHash.;' '' 'a slash leaves a proposal pending'
runl R32 $RS $R 'function zeroReputation(' 'delete evidenceRoots[didHash];' 'delete evidenceRoots.didHash.;' '' 'a slash leaves the evidence root'
runl R33 $RS $R 'function zeroReputation(' 'maturedScore[didHash] = 0;' 'maturedScore.didHash. = 0;' '' 'a slash leaves the maturity anchor'

# ---- SigvaraReputation: maturity ---------------------------------------------------------------------------------
runl R34 $RS $R 'function getTotalScore(' 'anchor = 0;' 'anchor = 0;' '' 'a handover does not restart maturity'
runl R35 $RS $R 'function getTotalScore(' '* maturityRatePerDay) / 1 days' '/ 1 days' '/ 1 hours' 'a score matures 24 times too fast'
runl R36 $RS $R 'function getTotalScore(' 'if (earned <= anchor) return earned;' 'return earned;' 'return anchor;' 'a fall is held at the anchor'
runl R37 $RS $R 'function getEarnedScore(' '+ uint16(rep.propagationScore);' '+ uint16(rep.propagationScore);' '+ 0;' 'the earned score leaves out propagation'

# ---- SigvaraReputation: the limits -------------------------------------------------------------------------------
runl R38 $RS $R 'function setChallengeWindow(' 'if (newWindow < MIN_CHALLENGE_WINDOW)' 'newWindow < MIN_CHALLENGE_WINDOW' 'false' 'the window has no floor'
runl R39 $RS $R 'function setChallengeWindow(' 'if (newWindow > MAX_CHALLENGE_WINDOW)' 'newWindow > MAX_CHALLENGE_WINDOW' 'false' 'the window has no ceiling'
runl R40 $RS $R 'function setMaturityRate(' 'if (pointsPerDay == 0)' 'pointsPerDay == 0' 'false' 'the maturity rate can be zero'
runl R41 $RS $R 'function setMaturityRate(' 'if (pointsPerDay > MAX_MATURITY_RATE_PER_DAY)' 'pointsPerDay > MAX_MATURITY_RATE_PER_DAY' 'false' 'the maturity rate has no ceiling'

# ---- SigvaraEpochFees: funding and withdrawing -------------------------------------------------------------------
runl E1  $FS $F 'function depositFor(' 'if (identityRegistry.getIdentity(didHash).registeredAt == 0)' 'identityRegistry.getIdentity(didHash).registeredAt == 0' 'false' 'a hash with no agent can be funded'
runl E2  $FS $F 'function depositFor(' 'balance[didHash] += received;' '+= received;' '= received;' 'a deposit replaces the balance instead of adding to it'
runl E3  $FS $F 'function withdraw(' 'if (id.operator != msg.sender)' 'id.operator != msg.sender' 'false' 'anyone can withdraw'
runl E4  $FS $F 'function withdraw(' 'balance[didHash] = bal - amount;' 'bal - amount;' 'bal;' 'a withdrawal does not reduce the balance'

# ---- SigvaraEpochFees: charging ----------------------------------------------------------------------------------
runl E5  $FS $F 'function chargeEpoch(' 'onlyRole(ORACLE_ROLE)' 'onlyRole(ORACLE_ROLE)' '' 'anyone can charge'
runl E6  $FS $F 'function chargeEpoch(' '_requireBondedOracle();' '_requireBondedOracle();' '' 'an oracle outside the bonded set can charge'
runl E7  $FS $F 'function chargeEpoch(' 'if (fee == 0) return true;' 'return true;' 'return false;' 'a disabled fee reports not charged'
runl E8  $FS $F 'function chargeEpoch(' 'uint256 epoch = block.timestamp / length;' 'block.timestamp / length' 'block.timestamp' 'the epoch is the timestamp itself'
runl E9  $FS $F 'function chargeEpoch(' 'if (last != 0 && last / length >= epoch)' 'last / length >= epoch' 'last / length > epoch' 'an agent can be charged twice in one epoch'
runl E10 $FS $F 'function chargeEpoch(' 'if (last != 0 && last / length >= epoch)' 'last != 0 && ' '' 'the first epoch cannot be charged'
runl E11 $FS $F 'function chargeEpoch(' 'balance[didHash] = bal - fee;' 'bal - fee;' 'bal;' 'a charge takes nothing from the balance'
runl E12 $FS $F 'function chargeEpoch(' 'lastChargedAt[didHash] = block.timestamp;' 'lastChargedAt.didHash. = block.timestamp;' '' 'a charge is not remembered'
runl E13 $FS $F 'function chargeEpoch(' 'collected += fee;' 'collected += fee;' '' 'a charge is not collected'

# ---- SigvaraEpochFees: distribution and the epoch length ---------------------------------------------------------
runl E14 $FS $F 'function distributeFees(' 'collected = 0;' 'collected = 0;' '' 'collected fees are not cleared when distributed'
runl E15 $FS $F 'function distributeFees(' 'if (amount == 0) revert NothingToDistribute();' 'amount == 0' 'false' 'an empty distribution goes through'
runl E16 $FS $F 'function distributeFees(' 'if (poolAmt > 0) svr.safeTransfer(rewardPool, poolAmt);' 'rewardPool, poolAmt' 'BURN_ADDRESS, poolAmt' 'the pool share is burned'
runl E17 $FS $F 'function _burnBps(' 'if (s == Stage.Transition) return 2_000;' '2_000' '2_500' 'the transition stage burns 25 percent'
runl E18 $FS $F 'function _burnBps(' 'if (s == Stage.Mature) return 5_000;' '5_000' '4_000' 'the mature stage burns 40 percent'
runl E19 $FS $F 'function _setEpochLength(' 'if (newLength < MIN_EPOCH_LENGTH)' 'newLength < MIN_EPOCH_LENGTH' 'false' 'the epoch length has no floor'
runl E20 $FS $F 'uint256 public constant MIN_EPOCH_LENGTH' 'uint256 public constant MIN_EPOCH_LENGTH' '= 1 hours;' '= 0;' 'the epoch length floor is zero'
echo "DONE: $(grep -c '=> \[FAIL' "$OUT") caught, $(grep -c SURVIVED "$OUT") survived, $(grep -cE 'NOT FOUND|NO CHANGE|COMPILE ERROR' "$OUT") did not test anything" >> "$OUT"
