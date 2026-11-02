#!/bin/bash
# Deliberate breaks of the fail-closed renounce, the timelock and Safe policy it enforces, what it will not take on
# trust (a Safe that is not Safe's code, has a module or a guard, keeps the deployer as a module, or is a delegated
# account, a timelock whose code it does not know or that the deployer did not create), the recorded deploy block,
# and the upgrade shape check. Each must fail a test. Run only against a committed tree.
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
runl F27 $S 'function _requireTimelockPhase2Made(' '_withoutMetadata(timelock.code)' '_withoutMetadata(timelock.code) != _withoutMetadata(expected)' 'false' 'a timelock of any code is accepted'
runl F28 $S 'function _requireTimelockPhase2Made(' '_withoutMetadata(timelock.code)' '_withoutMetadata(timelock.code) != _withoutMetadata(expected)' 'keccak256(timelock.code) != keccak256(expected)' 'the metadata is compared as well as the code'
runl F29 $S 'function _withoutMetadata(' 'if (n < 2)' 'n < 2' 'false' 'code too short to end in a length is not hashed whole'
runl F30 $S 'function _withoutMetadata(' 'if (cut > n)' 'cut > n' 'false' 'a length longer than the code is not hashed whole'
runl F31 $S 'function _withoutMetadata(' 'uint256 cut' '<< 8' '<< 7' 'the high byte of the metadata length is shifted wrong'
runl F32 $S 'function _requireKnownSafe(' 'if (!_vouchedFor(safe))' '!_vouchedFor(safe)' 'false' 'a Safe that is not Safe'"'"'s code is accepted without the confirmation'
runl F33 $S 'function _vouchedFor(' 'return named == safe;' 'named == safe' 'true' 'a confirmation naming another address is accepted'
runl F34 $S 'function _thresholdOf(' 'return type(uint256).max;' 'type(uint256).max' '0' 'a Safe the operator vouched for is held to a threshold of zero'
runl F35 $S 'function _thresholdOf(' 'ret.length == 32' 'ret.length == 32' 'ret.length >= 0' 'an empty answer is read as a threshold'
runl F36 $S 'function _isOwner(' 'ret.length < 64' 'ret.length < 64' 'ret.length < 0' 'an empty answer is read as a list of owners'
runl F37 $S 'function _requireTimelockPhase2Made(' 'vm.computeCreateAddress(deployer, n) == timelock' 'vm.computeCreateAddress(deployer, n) == timelock' 'true' 'a timelock with the right code is accepted whoever created it'
runl F38 $S 'function _requireTimelockPhase2Made(' 'for (uint256 n = 0;' 'n < nonce' 'n + 1 < nonce' 'the search for the creation misses the deployer'"'"'s latest one'
runl F39 $S 'function _requireTimelock()' '_requireTimelockPhase2Made(timelock);' '_requireTimelockPhase2Made(timelock);' '' 'no phase looks at what the timelock is or who created it'
runl F40 $S 'function _requireSafe()' 'revert SafeIsADelegatedAccount(safe)' 'c.length == 23 && c\[0\] == 0xef && c\[1\] == 0x01 && c\[2\] == 0x00' 'false' 'an EIP-7702 delegated account is accepted as the Safe'
runl F41 $S 'function _requireSafe()' 'revert SafeIsADelegatedAccount(safe)' 'c\[0\] == 0xef && c\[1\] == 0x01 && c\[2\] == 0x00' 'true' 'any 23 bytes of code are taken for a delegation'
runl F42 $S 'function _requireKnownSafe(' 'revert SafeHasModules(safe, admitted' 'admitted.length > 0' 'false' 'a multisig the operator named is accepted with a module it lists'
runl F43 $S 'function _requireKnownSafe(' 'if (!answered) revert SafeModulesUnreadable' '!answered' 'false' 'a Safe that will not list its modules is taken to have none'
runl F44 $S 'function _requireKnownSafe(' 'bytes(proxy).length == 0 ||' 'bytes(proxy).length == 0 || bytes(implementation).length == 0' 'false' 'anything that answers like a Safe is taken for Safe'"'"'s code'
runl F45 $S 'function _renounce()' '_requireKnownSafe(' '_requireKnownSafe(' 'if (false) _requireKnownSafe(' 'phase 5 never asks whether the Safe is Safe'"'"'s code'
runl F46 $S 'function _requireKnownSafe(' 'revert SafeHasModules(safe, modules' 'modules.length > 0' 'false' 'a Safe with a module enabled is accepted'
runl F47 $S 'function _requireKnownSafe(' 'revert SafeHasGuard(' 'guard != address(0)' 'false' 'a Safe with a guard is accepted'
runl F48 $S 'function _requireKnownSafe(' 'revert DeployerIsAModule(' 'abi.decode(ret, (bool))' 'false' 'the deployer as a module outside the list is not found'
echo "DONE" >> "$OUT"
