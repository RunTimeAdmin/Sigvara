#!/bin/bash
# Deliberate breaks of the pre-freeze changes, one at a time. Each must make a test fail.
# Files are restored with git checkout after every mutant (all changes are committed first),
# and again on exit. Never run two copies at once, and do not edit the tree while it runs.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO:-$REPO_DEFAULT}" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-pf-results.txt}
: > "$OUT"
restore() { git checkout -- src script test foundry.toml 2>/dev/null; }
trap restore EXIT

run() { # id, file, sed expression, test filter, what it breaks
  id=$1; file=$2; expr=$3; filter=$4; what=$5
  restore
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then echo "$id: NO CHANGE APPLIED (bad sed), $what" >> "$OUT"; return; fi
  res=$(forge test --match-test "$filter" 2>&1 | grep -E "^Ran [0-9]+ test suites|\[FAIL" | cut -c1-140 | head -5 | tr '\n' ' ')
  echo "$id: $what => $res" >> "$OUT"
  restore
}

run M1 script/Deploy.s.sol '/^        _checkMainnetMinimumStake(minStake);$/d' \
  'test_deployAndEpochFeesRunUnderMainnetRules' 'Deploy.run no longer calls the minimum stake guard'
run M2 script/DeployOracleBond.s.sol '/^        _checkMainnetBondAmount(bondAmount);$/d' \
  'test_deployAndEpochFeesRunUnderMainnetRules' 'DeployOracleBond.run no longer calls the bond amount guard'
run M3 src/SigvaraStaking.sol '/if (unbondingPeriod_ < MIN_UNBONDING_PERIOD) revert PeriodTooShort/d' \
  'test_initializeV2_' 'initializeV2 has no floor'
run M4 script/Deploy.s.sol 's/if (minStake == DEFAULT_MINIMUM_STAKE) revert/if (minStake != DEFAULT_MINIMUM_STAKE) revert/' \
  'test_mainnet_|test_testnet_stillAccepts|test_deployAndEpochFeesRunUnderMainnetRules' 'minimum stake guard inverted'
run M5 script/DeployOracleBond.s.sol '/if (block.chainid != ARC_MAINNET) return;/d' \
  'test_oracleBond_' 'bond amount guard applies on testnet too'
run M6 src/SigvaraStaking.sol 's/if (unbondingPeriod_ < MIN_UNBONDING_PERIOD)/if (unbondingPeriod_ <= MIN_UNBONDING_PERIOD)/' \
  'test_initializeV2_' 'floor off by one (the floor itself refused)'
run M7 script/DeployOracleBond.s.sol 's/if (bondAmount == DEFAULT_BOND) revert/if (bondAmount != DEFAULT_BOND) revert/' \
  'test_oracleBond_|test_deployAndEpochFeesRunUnderMainnetRules' 'bond amount guard inverted'
echo "DONE" >> "$OUT"
