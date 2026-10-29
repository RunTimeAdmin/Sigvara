#!/bin/bash
# Deliberate breaks of the fail-closed renounce, the timelock and Safe policy it enforces, the recorded deploy
# block, and the upgrade shape check. Each must fail a test. Run only against a committed tree.
REPO_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO=${REPO:-$REPO_DEFAULT}
cd "$REPO" || exit 1
OUT=${OUT:-${TMPDIR:-/tmp}/mutate-p4-handover-results.txt}
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
  out=$(forge test --match-contract 'SplitAuthorityTest|UpgradeDependencyTest|DeployScriptGuardsTest' 2>&1)
  res=$(echo "$out" | grep -E "\[FAIL" | cut -c1-110 | head -3 | tr '\n' ' ')
  if echo "$out" | grep -q "Compiler run failed"; then res="COMPILE ERROR"; elif [ -z "$res" ]; then res="SURVIVED (no test failed)"; fi
  echo "$id: $what => $res" >> "$OUT"
  restore
}
S=script/SplitAuthority.s.sol
U=script/Upgrade.s.sol
D=script/Deploy.s.sol
runl F1 $S 'function _renounce()' 'revert UpgraderRoleNotSelfAdministered(targets[i].name);' '!_upgraderAdminIsSelf(targets\[i\].addr)' 'false' 'renounce no longer checks that the upgrader role administers itself'
runl F2 $S 'function _renounce()' 'if (open) revert RoleNotTimelocked(targets[i].name, role);' 'if (open)' 'if (false)' 'renounce no longer checks the fund-moving roles'
runl F3 $S 'function _timelockedRoles(' 'roles[0] = STAKING_CORE_ROLE;' 'STAKING_CORE_ROLE' 'SLASHER_ROLE' 'the table lists the wrong role for identity'
runl F4 $S 'else if (h == keccak256("reputation")) {' 'roles = new bytes32[](2);' '(2)' '(1)' 'the table drops the committee role on reputation'
runl F5 $S 'else if (h == keccak256("staking")) {' 'roles[0] = SLASHING_COMMITTEE_ROLE;' 'SLASHING_COMMITTEE_ROLE' 'STAKING_CORE_ROLE' 'the table lists the wrong role for staking'
runl F6 $S 'else if (h == keccak256("oracleBond")) {' 'roles = new bytes32[](1);' '(1)' '(0)' 'the table lists nothing for the bond registry'
runl F7 $S 'function _firstRoleTheAdminCanGrant(' 'abi.decode(ret, (bytes32)) != UPGRADER_ROLE' '!= UPGRADER_ROLE' '== UPGRADER_ROLE' 'a role administered by the upgrader reads as open'
runl F8 $S 'function _firstRoleTheAdminCanGrant(' 'return (true, roles[i]);' 'return (true, roles\[i\]);' 'continue;' 'an open role is never reported'
runl F9 $U 'function _requireShape(' 'if (!_answers(proxy, _shapeProbe(target)))' '!_answers(proxy, _shapeProbe(target))' 'false' 'the shape check never refuses'
runl F10 $U 'function _shapeProbe(' 'return abi.encodeWithSignature("minimumStake()");' 'minimumStake()' 'challengeWindow()' 'the staking probe asks the reputation getter'
runl F11 $U 'function _shapeProbe(' 'return abi.encodeWithSignature("computeDidHash(address)", address(0));' 'computeDidHash(address)' 'minimumStake()' 'the identity probe asks a staking getter'
runl F12 $U 'function run()' '_requireShape(target, proxy);' '_requireShape(target, proxy);' '' 'run() stops calling the shape check'
runl F13 $S 'function _requireTimelockPolicy(' 'if (delay < DEFAULT_MIN_DELAY)' 'delay < DEFAULT_MIN_DELAY)' 'delay < 1)' 'the delay floor only refuses a delay of zero'
runl F14 $S 'function _requireTimelockPolicy(' 'if (delay < DEFAULT_MIN_DELAY)' 'delay < DEFAULT_MIN_DELAY)' 'delay <= DEFAULT_MIN_DELAY)' 'the delay floor refuses exactly 48 hours'
runl F15 $S 'function _requireTimelockPolicy(' 'CANCELLER_ROLE' '!tl.hasRole(tl.CANCELLER_ROLE(), safe)' 'false' 'the Safe is not required to be able to cancel'
runl F16 $S 'function _requireTimelockPolicy(' 'EXECUTOR_ROLE' '!tl.hasRole(tl.EXECUTOR_ROLE(), address(0))' 'false' 'execution does not have to be open'
runl F17 $S 'function _requireTimelockPolicy(' 'TimelockHasOutsideAdmin(timelock, safe)' 'tl.hasRole(ADMIN_ROLE, safe)' 'false' 'the Safe may administer the timelock'
runl F18 $S 'function _requireTimelockPolicy(' 'TimelockHasOutsideAdmin(timelock, deployer)' 'tl.hasRole(ADMIN_ROLE, deployer)' 'false' 'the deployer may administer the timelock'
runl F19 $S 'function _renounce()' 'if (threshold < MIN_SAFE_THRESHOLD)' 'threshold < MIN_SAFE_THRESHOLD)' 'threshold < 1)' 'the Safe threshold floor only refuses zero'
runl F20 $S 'uint256 internal constant MIN_SAFE_THRESHOLD' 'MIN_SAFE_THRESHOLD = 2' '= 2;' '= 3;' 'the Safe threshold floor is three'
runl F21 $S 'function _requireTimelock()' 'if (timelock.code.length == 0)' 'timelock.code.length == 0' 'false' 'a timelock address with no code is accepted'
runl F22 $S 'uint256 internal constant DEFAULT_MIN_DELAY' 'DEFAULT_MIN_DELAY = 48 hours' '48 hours' '1 hours' 'the delay floor is one hour'
runl F23 $S 'function _renounce()' 'DeployerCanActAlone(safe)' '<= 1' '<= 0' 'a Safe the deployer owns at threshold one is no longer refused for what it is'
runl F24 $D 'function _firstBlock(' 'if (earlier < first)' 'earlier < first' 'earlier > first' 'a later run can move the recorded block forward'
runl F25 $D 'function _firstBlock(' 'if (!vm.exists(path))' 'return first;' 'return 0;' 'with no artifact the recorded block is zero'
runl F26 $D 'function _firstBlock(' 'if (!vm.keyExistsJson' 'return first;' 'return 0;' 'an artifact without a block records zero'
echo "DONE" >> "$OUT"
