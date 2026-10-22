# Post-deploy assertions for the Arc mainnet deployment.
#
# Source it, then call the checks that match the step you have just finished. Every line
# prints ok or FAIL, and a read that cannot reach the chain counts as a FAIL, not a skip.
#
#   source scripts/check-mainnet.sh
#   check_core
#
# Run from the repository root with bash 4 or later (Git Bash is fine).
#
# What you must export first. These come from you, not from the artifact, so that a wrong
# artifact cannot vouch for itself:
#   SVR        the published SVR token address (docs/token.md)
#   DEPLOYER   the address of the deploy key
#   ORACLE     the oracle wallet
#   COMMITTEE  the committee multisig
#   GUARDIAN   the pause guardian    (check_core, check_bond_and_fees, check_holders)
#   TREASURY   the slash beneficiary and reward pool
#   SAFE       the admin Safe        (check_authority, check_timelock, check_safes, check_holders)
#   TIMELOCK   the timelock          (check_authority, check_timelock, check_holders)
# check_safes also reads SAFE_OWNERS, COMMITTEE_OWNERS and SAFE_THRESHOLD, which must be
# copied from what the signers see on their own devices (see that function).
# RPC defaults to the arc_mainnet alias in foundry.toml.
#
# The expected parameters are the mainnet values in docs/token.md and the periods that
# script/Deploy.s.sol and script/DeployOracleBond.s.sol default to. Change them here if
# you deploy with different ones.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "source this file, do not run it: source scripts/check-mainnet.sh" >&2
  exit 1
fi

RPC=${RPC:-arc_mainnet}
ARTIFACT=deployments/5042.json

WANT_MIN_STAKE=$(cast to-wei 10000)     # 10,000 SVR
WANT_BOND=$(cast to-wei 2500000)        # 2,500,000 SVR
WANT_CHALLENGE=604800                   # 7 days
WANT_UNBONDING=1814400                  # 21 days
WANT_SCORE_WINDOW=21600                 # 6 hours
WANT_MATURITY=4                         # points of score released per day
WANT_BOND_UNBONDING=604800              # 7 days
WANT_TIMELOCK_DELAY=172800              # 48 hours
WANT_COMMITTEE_THRESHOLD=3              # of 5

ZERO_ADDR=0x0000000000000000000000000000000000000000
ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
UPGRADER_ROLE=$(cast keccak "UPGRADER_ROLE")
ORACLE_ROLE=$(cast keccak "ORACLE_ROLE")
COMMITTEE_ROLE=$(cast keccak "SLASHING_COMMITTEE_ROLE")
SLASHER_ROLE=$(cast keccak "SLASHER_ROLE")
STAKING_CORE_ROLE=$(cast keccak "STAKING_CORE_ROLE")
GUARDIAN_ROLE=$(cast keccak "GUARDIAN_ROLE")
INIT_SLOT=0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00   # OpenZeppelin Initializable
FAIL=0

# val <contract> <signature> [args...]: first word of the answer, lowercased
val() { local c=$1 s=$2; shift 2; cast call "$c" "$s" "$@" --rpc-url "$RPC" 2>/dev/null | awk '{print tolower($1)}'; }

# expect <label> <want> <got>
expect() {
  if [ -n "$3" ] && [ "${2,,}" = "${3,,}" ]; then echo "ok    $1"; else echo "FAIL  $1 (want $2, got ${3:-nothing})"; FAIL=1; fi
}

# has <contract> <role> <account> <true|false> <label>
has() { expect "$5" "$4" "$(val "$1" "hasRole(bytes32,address)(bool)" "$2" "$3")"; }

art() { node -p "require('./$ARTIFACT')['$1']" 2>/dev/null; }

# initialized <contract>: how many initializer versions have run. A reinitializer that
# Deploy.s.sol leaves unused stays callable by the admin for good.
initialized() { local v; v=$(cast storage "$1" $INIT_SLOT --rpc-url "$RPC" 2>/dev/null) && [ -n "$v" ] && echo $((16#${v: -16})); }

# owners_of: reads a list of addresses on stdin, prints them lowercased, sorted, on one line
owners_of() { tr ',' '\n' | tr -d '[] ' | tr A-F a-f | sed '/^$/d' | sort | tr '\n' ' '; }

# Proxy addresses come from the artifact. load_artifact <the keys this check needs>: a
# missing key is a FAIL, because SplitAuthority skips a name the artifact lacks, which would
# leave the deployer in charge of that contract.
load_artifact() {
  local k v
  for k in "$@"; do
    v=$(art $k)
    if [ -z "$v" ] || [ "$v" = "undefined" ]; then echo "FAIL  $ARTIFACT has no $k"; FAIL=1; fi
  done
  IDENTITY=$(art identity); REPUTATION=$(art reputation); STAKING=$(art staking)
  BOND=$(art oracleBond); FEES=$(art epochFees)
}

summary() { [ $FAIL = 0 ] && echo "$1: all checks passed" || echo "$1: STOP, something above failed"; }

# check_core [operatorBond]: identity, reputation and staking as Deploy.s.sol wires them.
# Pass the oracleBond address once reputation has been pointed at it; it is unset until then.
check_core() {
  FAIL=0; load_artifact identity reputation staking
  expect "staking.svrToken is SVR"        "$SVR"             "$(val $STAKING 'svrToken()(address)')"
  expect "staking.minimumStake"           "$WANT_MIN_STAKE"  "$(val $STAKING 'minimumStake()(uint256)')"
  expect "staking.challengePeriod"        "$WANT_CHALLENGE"  "$(val $STAKING 'challengePeriod()(uint256)')"
  expect "staking.unbondingPeriod"        "$WANT_UNBONDING"  "$(val $STAKING 'unbondingPeriod()(uint256)')"
  expect "staking.identityRegistry"       "$IDENTITY"        "$(val $STAKING 'identityRegistry()(address)')"
  expect "staking.reputationRegistry"     "$REPUTATION"      "$(val $STAKING 'reputationRegistry()(address)')"
  expect "identity.stakeView is staking"  "$STAKING"         "$(val $IDENTITY 'stakeView()(address)')"
  expect "reputation.identityRegistry"    "$IDENTITY"        "$(val $REPUTATION 'identityRegistry()(address)')"
  expect "reputation.challengeWindow"     "$WANT_SCORE_WINDOW" "$(val $REPUTATION 'challengeWindow()(uint256)')"
  expect "reputation.maturityRatePerDay"  "$WANT_MATURITY"   "$(val $REPUTATION 'maturityRatePerDay()(uint256)')"
  expect "reputation.operatorBond"        "${1:-$ZERO_ADDR}" "$(val $REPUTATION 'operatorBond()(address)')"
  expect "identity: every initializer has run (2)"    2      "$(initialized $IDENTITY)"
  expect "reputation: every initializer has run (4)"  4      "$(initialized $REPUTATION)"
  expect "staking: initializeV2 has run (2)"          2      "$(initialized $STAKING)"
  has $IDENTITY   $STAKING_CORE_ROLE $STAKING   true "identity: staking holds STAKING_CORE"
  has $REPUTATION $STAKING_CORE_ROLE $STAKING   true "reputation: staking holds STAKING_CORE"
  has $REPUTATION $ORACLE_ROLE       $ORACLE    true "reputation: oracle holds ORACLE"
  has $REPUTATION $COMMITTEE_ROLE    $COMMITTEE true "reputation: committee holds SLASHING_COMMITTEE"
  has $STAKING    $COMMITTEE_ROLE    $COMMITTEE true "staking: committee holds SLASHING_COMMITTEE"
  has $IDENTITY   $GUARDIAN_ROLE     $GUARDIAN  true "identity: guardian holds GUARDIAN"
  has $REPUTATION $GUARDIAN_ROLE     $GUARDIAN  true "reputation: guardian holds GUARDIAN"
  has $STAKING    $GUARDIAN_ROLE     $GUARDIAN  true "staking: guardian holds GUARDIAN"
  # A reachable inflowsPaused() also shows the deployed code has the pause at all. Nothing is
  # paused at launch.
  expect "identity: inflows are open"     false "$(val $IDENTITY   'inflowsPaused()(bool)')"
  expect "reputation: inflows are open"   false "$(val $REPUTATION 'inflowsPaused()(bool)')"
  expect "staking: inflows are open"      false "$(val $STAKING    'inflowsPaused()(bool)')"
  # The deployer is admin and upgrader until the handover and should hold nothing else.
  has $IDENTITY   $STAKING_CORE_ROLE $DEPLOYER  false "identity: deployer does not hold STAKING_CORE"
  has $REPUTATION $STAKING_CORE_ROLE $DEPLOYER  false "reputation: deployer does not hold STAKING_CORE"
  has $REPUTATION $ORACLE_ROLE       $DEPLOYER  false "reputation: deployer does not hold ORACLE"
  has $REPUTATION $COMMITTEE_ROLE    $DEPLOYER  false "reputation: deployer does not hold SLASHING_COMMITTEE"
  has $STAKING    $COMMITTEE_ROLE    $DEPLOYER  false "staking: deployer does not hold SLASHING_COMMITTEE"
  has $IDENTITY   $GUARDIAN_ROLE     $DEPLOYER  false "identity: deployer does not hold GUARDIAN"
  has $REPUTATION $GUARDIAN_ROLE     $DEPLOYER  false "reputation: deployer does not hold GUARDIAN"
  has $STAKING    $GUARDIAN_ROLE     $DEPLOYER  false "staking: deployer does not hold GUARDIAN"
  summary core
}

# check_bond_and_fees: the operator bond registry and the epoch fee registry.
check_bond_and_fees() {
  FAIL=0; load_artifact identity oracleBond epochFees
  expect "oracleBond.svr is SVR"          "$SVR"              "$(val $BOND 'svr()(address)')"
  expect "oracleBond.bondAmount"          "$WANT_BOND"        "$(val $BOND 'bondAmount()(uint256)')"
  expect "oracleBond.unbondingPeriod"     "$WANT_BOND_UNBONDING" "$(val $BOND 'unbondingPeriod()(uint256)')"
  expect "oracleBond.slashBeneficiary"    "$TREASURY"         "$(val $BOND 'slashBeneficiary()(address)')"
  expect "oracleBond: initialized once (1)"    1              "$(initialized $BOND)"
  expect "epochFees: initialized once (1)"     1              "$(initialized $FEES)"
  has $BOND $SLASHER_ROLE $COMMITTEE true  "oracleBond: committee holds SLASHER"
  has $BOND $SLASHER_ROLE $DEPLOYER  false "oracleBond: deployer does not hold SLASHER"
  has $BOND $GUARDIAN_ROLE $GUARDIAN true  "oracleBond: guardian holds GUARDIAN"
  has $BOND $GUARDIAN_ROLE $DEPLOYER false "oracleBond: deployer does not hold GUARDIAN"
  expect "oracleBond: inflows are open"       false               "$(val $BOND 'inflowsPaused()(bool)')"
  expect "epochFees.svr is SVR"           "$SVR"              "$(val $FEES 'svr()(address)')"
  expect "epochFees.identityRegistry"     "$IDENTITY"         "$(val $FEES 'identityRegistry()(address)')"
  expect "epochFees.epochFee is 0"        0                   "$(val $FEES 'epochFee()(uint256)')"
  expect "epochFees.rewardPool"           "$TREASURY"         "$(val $FEES 'rewardPool()(address)')"
  has $FEES $ORACLE_ROLE $ORACLE   true  "epochFees: oracle holds ORACLE"
  has $FEES $ORACLE_ROLE $DEPLOYER false "epochFees: deployer does not hold ORACLE"
  summary bond+fees
}

# check_authority <admin holder> <upgrader holder>
# Before the handover that is $DEPLOYER twice. After it, $SAFE and $TIMELOCK, and the
# deployer must hold neither role on any of the five.
check_authority() {
  FAIL=0; load_artifact identity reputation staking oracleBond epochFees
  local pair n c who
  for pair in identity:$IDENTITY reputation:$REPUTATION staking:$STAKING oracleBond:$BOND epochFees:$FEES; do
    n=${pair%%:*}; c=${pair#*:}
    has $c $ADMIN_ROLE    $1 true "$n: admin is $1"
    has $c $UPGRADER_ROLE $2 true "$n: upgrader is $2"
    for who in $ORACLE $COMMITTEE; do
      has $c $ADMIN_ROLE    $who false "$n: $who is not admin"
      has $c $UPGRADER_ROLE $who false "$n: $who is not upgrader"
    done
    if [ "${1,,}" != "${DEPLOYER,,}" ]; then has $c $ADMIN_ROLE    $DEPLOYER false "$n: deployer dropped admin"; fi
    if [ "${2,,}" != "${DEPLOYER,,}" ]; then has $c $UPGRADER_ROLE $DEPLOYER false "$n: deployer dropped upgrader"; fi
  done
  summary authority
}

# check_timelock: delay, who proposes and cancels, that anyone executes, and that nobody
# can rewrite the timelock's own roles except through the timelock.
check_timelock() {
  FAIL=0
  local prop canc exec
  prop=$(cast call $TIMELOCK 'PROPOSER_ROLE()(bytes32)'  --rpc-url "$RPC" 2>/dev/null)
  canc=$(cast call $TIMELOCK 'CANCELLER_ROLE()(bytes32)' --rpc-url "$RPC" 2>/dev/null)
  exec=$(cast call $TIMELOCK 'EXECUTOR_ROLE()(bytes32)'  --rpc-url "$RPC" 2>/dev/null)
  expect "timelock.minDelay"                  "$WANT_TIMELOCK_DELAY" "$(val $TIMELOCK 'getMinDelay()(uint256)')"
  has $TIMELOCK "$prop"     $SAFE     true  "timelock: Safe can propose"
  has $TIMELOCK "$canc"     $SAFE     true  "timelock: Safe can cancel"
  has $TIMELOCK "$exec"     $ZERO_ADDR true "timelock: anyone can execute"
  has $TIMELOCK $ADMIN_ROLE $SAFE     false "timelock: Safe is not its admin"
  has $TIMELOCK $ADMIN_ROLE $DEPLOYER false "timelock: deployer is not its admin"
  has $TIMELOCK $ADMIN_ROLE $TIMELOCK true  "timelock: administers itself"
  summary timelock
}

# check_impl <implementation address> <contract name>: the code at the address is what this
# working tree builds. The implementation's own address sits in its code as an immutable, so
# it is masked before comparing.
check_impl() {
  local impl=$1 c=$2 lower onchain built
  lower=${impl,,}
  onchain=$(cast code "$impl" --rpc-url "$RPC" 2>/dev/null); onchain=${onchain,,}
  onchain=${onchain//${lower#0x}/0000000000000000000000000000000000000000}
  built=$(forge inspect "$c" deployedBytecode 2>/dev/null); built=${built,,}
  if [ -n "$built" ] && [ "$onchain" = "$built" ]; then echo "ok    $impl is the build of $c"; else echo "FAIL  $impl is not the build of $c"; FAIL=1; fi
}

# check_new_implementation <address> <contract name>: run it on a new implementation before
# the Safe schedules the upgrade, not after the delay has run.
check_new_implementation() { FAIL=0; check_impl "$1" "$2"; summary implementation; }

# check_code: the code behind each proxy is what this working tree builds. Reads the
# implementation addresses from the artifact, so run record-implementations first.
check_code() {
  FAIL=0
  local pair n impl
  for pair in identity:SigvaraIdentity reputation:SigvaraReputation staking:SigvaraStaking oracleBond:SigvaraOracleBond epochFees:SigvaraEpochFees; do
    n=${pair%%:*}
    impl=$(node -p "require('./$ARTIFACT').implementations['$n'].current" 2>/dev/null)
    if [ -z "$impl" ] || [ "$impl" = "undefined" ]; then echo "FAIL  $n: no implementation recorded"; FAIL=1; continue; fi
    check_impl "$impl" "${pair#*:}"
  done
  summary code
}

# check_safes: the two Safes are the ones the signers confirmed, not just any Safe. The chain
# cannot vouch for itself: a lookalike address owned by someone else passes every other
# check. Export, from what each signer reads on their own device and not from the chain:
#   SAFE_OWNERS, COMMITTEE_OWNERS   comma-separated owner addresses
#   SAFE_THRESHOLD                  the admin Safe's threshold, 2 or more
check_safes() {
  FAIL=0
  local confirmed
  expect "admin Safe owners are the confirmed list" "$(echo "$SAFE_OWNERS" | owners_of)" "$(cast call $SAFE 'getOwners()(address[])' --rpc-url "$RPC" 2>/dev/null | owners_of)"
  expect "admin Safe threshold is the confirmed one" "$SAFE_THRESHOLD" "$(val $SAFE 'getThreshold()(uint256)')"
  if [ "${SAFE_THRESHOLD:-0}" -lt 2 ]; then echo "FAIL  the admin Safe needs a threshold of 2 or more (SAFE_THRESHOLD is ${SAFE_THRESHOLD:-unset})"; FAIL=1; fi
  expect "committee owners are the confirmed list" "$(echo "$COMMITTEE_OWNERS" | owners_of)" "$(cast call $COMMITTEE 'getOwners()(address[])' --rpc-url "$RPC" 2>/dev/null | owners_of)"
  expect "committee has five owners" 5 "$(echo "$COMMITTEE_OWNERS" | owners_of | wc -w | tr -d ' ')"
  expect "committee threshold" "$WANT_COMMITTEE_THRESHOLD" "$(val $COMMITTEE 'getThreshold()(uint256)')"
  confirmed=" $(echo "$SAFE_OWNERS,$COMMITTEE_OWNERS" | owners_of) "
  case "$confirmed" in *" ${DEPLOYER,,} "*) echo "FAIL  the deployer is an owner of a Safe"; FAIL=1;; esac
  summary safes
}

# check_holders: who holds every role, replayed from the chain's own events, so a grant
# nobody expected is seen. Needs SAFE, TIMELOCK, COMMITTEE, ORACLE and GUARDIAN exported. Run
# it after the handover. RPC_URL (not RPC) picks the endpoint for the replay.
check_holders() { node scripts/check-role-holders.mjs; }
