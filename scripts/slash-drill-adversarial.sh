#!/usr/bin/env bash
# The adversarial slash drill on Arc testnet: docs/slash-drill.md, "The adversarial drill".
# Rehearsed by test/SlashDrillAdversarialFork.t.sol. Needs Foundry's cast.
#
# Each subcommand is one signer's part. Keys are read from the terminal (or stdin, one per line)
# and never taken as arguments, echoed or written anywhere.
#
#   status           every drill proposal and agent, read only
#   operator-setup   faucet SVR, register A, B and C, bond each   (operator key, then A, B, C keys)
#   committee-day0   file A, B and C                              (SLASHING_COMMITTEE_ROLE key)
#   operator-dispute dispute A, with the guards either side of it (operator key)
#   admin-day0       veto B; drop A once it is disputed           (DEFAULT_ADMIN_ROLE key)
#   guards-day0      after admin-day0: the cooldowns, C too early  (no key)
#   guards-day7      before committee-day7: rejected evidence, C past its deadline (no key)
#   committee-day7   A again with new evidence, then withdraw it  (SLASHING_COMMITTEE_ROLE key)
#   anyone-day21     expire C once it has lapsed, guards around it (any funded key)
#
# A guard is a call that must revert. It runs with `cast call --from` the account named, costs
# nothing, and prints the error the contract gave, or GUARD DID NOT FIRE.
set -euo pipefail

RPC=${RPC:-https://rpc.testnet.arc.io}
CHAIN_ID=5042002
IDENTITY=0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd
STAKING=0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B
SVR=0x41De2D6D55318e197a00E8f5B496eA2790e23E6c

# The drill's own accounts. The operator holds no role; it registers and bonds the three
# agents, disputes A, and is the victim each filing names (never a committee member).
OPERATOR=0x11bbb7764D215c7Ab2E7c677283E226D599ce956
AGENT_A=0xa656eBa21833c208B5Dbe3faFf4F6438b4Cc39E7
AGENT_B=0x52900e0ec5ca59B9e57327e0c6Ba1f7B8fd88A80
AGENT_C=0xebc125b2AB79586299BF2274582C6f63dB6300F8
A=0x31d086504826b5cee68c36448d14e667e8535ca8a8f50bb3cb5ea72db1c3165b
B=0xa8e330e0c4ff506ca21f786a7bfc1b37495390d2b0715996cc726e3573630453
C=0x30b95fc4473e5ea0f187d4955ab24bcfebd7a739a0a93c1beafd5d6445f1d93a

# What each filing says. Plain text, so the slashes page shows it as written.
EVIDENCE_A="drill 2026-11 A: adversarial drill, not a finding. Expect a dispute and the admin to drop it."
EVIDENCE_B="drill 2026-11 B: adversarial drill, not a finding. Expect the admin to veto it."
EVIDENCE_C="drill 2026-11 C: adversarial drill, not a finding. Expect nobody to act and the proposal to lapse."
EVIDENCE_A2="drill 2026-11 A, day 7: new evidence after the cooldown. Expect the committee to withdraw it."

BOND=1000000000000000000000   # minimumStake on Arc testnet, 1,000 SVR
STATE_NAMES=(None Pending Executed Cancelled Disputed)
STATUS_NAMES=(Active Suspended Slashed PendingBond)

COMMITTEE=0x045D6C1d8404297F13596061388f6598fA94a5b7
ADMIN=0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811
PASSERBY=0x000000000000000000000000000000000000dEaD
ERRORS="VictimIsReporter(address) NotOperator(bytes32,address) ChallengePeriodActive(bytes32,uint256)
ExecutionPeriodActive(bytes32,uint256) SlashCooldownActive(bytes32,uint256) EvidenceAlreadyRejected(bytes32,bytes32)
ChallengePeriodExpired(bytes32,uint256) SlashAlreadyPending(bytes32) NoActivePendingSlash(bytes32) SlashNotDisputed(bytes32)"

die() { echo "slash-drill: $*" >&2; exit 1; }
guard() {  # guard <what> <from> <contract> <signature> [args...]: must revert; prints which error
  local what=$1 from=$2 out data name=unknown e; shift 2
  if out=$(cast call --from "$from" "$@" --rpc-url "$RPC" 2>&1); then echo "GUARD DID NOT FIRE: $what"; return; fi
  data=$(echo "$out" | grep -o '0x[0-9a-fA-F]\{8,\}' | head -1)
  for e in $ERRORS; do [ "${data:0:10}" = "$(cast sig "$e")" ] && name=${e%%(*}; done
  echo "guard: $what -> $name"
}
hex() { printf '0x%s' "$(printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n')"; }
read_key() {
  local k
  if [ -t 0 ]; then read -rs -p "$1 key: " k; echo >&2; else IFS= read -r k; fi
  [[ "$k" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || die "that is not a private key (it is not shown)"
  printf '%s' "$k"
}
send() {  # send <key> <to> <sig> [args...]; prints the transaction hash
  local key=$1; shift
  cast send "$@" --rpc-url "$RPC" --private-key "$key" --json | sed -n 's/.*"transactionHash":"\(0x[0-9a-f]*\)".*/\1/p'
}
slash_state() {  # the proposal's state, by name
  local t; t=$(cast call "$STAKING" "getSlashProposal(bytes32)((bytes32,address,address,uint256,uint8,bytes,uint256,uint256))" "$1" --rpc-url "$RPC")
  echo "${STATE_NAMES[$(echo "$t" | tr -d '()' | cut -d, -f5 | tr -d ' ')]}"
}
agent_status() {  # an unregistered didHash reads as all zeros, and status 0 is Active, so check registeredAt
  local t; t=$(cast call "$IDENTITY" "identities(bytes32)(address,address,bytes32,uint8,uint256)" "$1" --rpc-url "$RPC")
  if [ "$(echo "$t" | sed -n 5p | cut -d' ' -f1)" = 0 ]; then echo Unregistered; else echo "${STATUS_NAMES[$(echo "$t" | sed -n 4p)]}"; fi
}
stake() { cast call "$STAKING" "getStake(bytes32)(uint256)" "$1" --rpc-url "$RPC" | cut -d' ' -f1; }
expect_state() { [ "$(slash_state "$1")" = "$2" ] || die "$3: proposal is $(slash_state "$1"), expected $2"; }

[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || die "the RPC is not Arc testnet"

case "${1:-}" in
  status)
    for n in A B C; do
      d=${!n}
      echo "$n $d  agent $(agent_status "$d")  stake $(stake "$d")  proposal $(slash_state "$d")"
    done
    ;;

  operator-setup)
    OK=$(read_key "operator")
    [ "$(cast wallet address --private-key "$OK")" = "$OPERATOR" ] || die "that key is not the drill operator"
    echo "faucet:   $(send "$OK" "$SVR" "faucet(uint256)" 3000000000000000000000)"
    echo "approve:  $(send "$OK" "$SVR" "approve(address,uint256)" "$STAKING" 3000000000000000000000)"
    for n in A B C; do
      AK=$(read_key "agent $n"); agent_var=AGENT_$n
      [ "$(cast wallet address --private-key "$AK")" = "${!agent_var}" ] || die "that key is not agent $n"
      PUB=$(cast keccak "ed25519 placeholder for drill agent $n")
      DIGEST=$(cast call "$IDENTITY" "registrationDigest(address,address,bytes32)(bytes32)" "${!agent_var}" "$OPERATOR" "$PUB" --rpc-url "$RPC")
      # Bare form: hex-decoded and given the Ethereum Signed Message prefix, as verifyRegistration
      # expects (see "Step 0" above in the drill doc).
      SIG=$(cast wallet sign "$DIGEST" --private-key "$AK"); unset AK
      echo "register $n: $(send "$OK" "$IDENTITY" "registerAgent(address,bytes32,bytes)" "${!agent_var}" "$PUB" "$SIG")"
      echo "bond $n:     $(send "$OK" "$STAKING" "depositStake(bytes32,uint256)" "${!n}" "$BOND")"
      [ "$(agent_status "${!n}")" = Active ] || die "agent $n is not Active after bonding"
    done
    ;;

  committee-day0)
    for n in A B C; do
      [ "$(agent_status "${!n}")" = Active ] && [ "$(stake "${!n}")" = "$BOND" ] || die "agent $n is not bonded and Active; run operator-setup first"
      expect_state "${!n}" None "$n"
    done
    K=$(read_key "committee")
    for n in A B C; do
      ev=EVIDENCE_$n
      echo "file $n: $(send "$K" "$STAKING" "initiateSlash(bytes32,address,bytes)" "${!n}" "$OPERATOR" "$(hex "${!ev}")")"
    done
    ;;

  operator-dispute)
    expect_state "$A" Pending A
    OK=$(read_key "operator")
    guard "committee names itself the victim" "$COMMITTEE" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$A" "$COMMITTEE" 0x00
    guard "anyone but A's operator disputes A" "$PASSERBY" "$STAKING" "disputeSlash(bytes32)" "$A"
    echo "dispute A: $(send "$OK" "$STAKING" "disputeSlash(bytes32)" "$A")"
    # Straight after the dispute, while admin-day0 is still waiting to see it.
    guard "admin upholds A inside the window" "$ADMIN" "$STAKING" "resolveDispute(bytes32,bool)" "$A" true
    ;;

  guards-day0)
    expect_state "$A" Cancelled A; expect_state "$B" Cancelled B; expect_state "$C" Pending C
    guard "committee files A again at once" "$COMMITTEE" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$A" "$OPERATOR" 0x01
    guard "committee files B again at once" "$COMMITTEE" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$B" "$OPERATOR" 0x01
    guard "anyone executes C inside its window" "$PASSERBY" "$STAKING" "executeSlash(bytes32)" "$C"
    guard "anyone expires C before it lapses" "$PASSERBY" "$STAKING" "expireSlash(bytes32)" "$C"
    ;;

  guards-day7)
    expect_state "$A" Cancelled A
    guard "committee refiles A with the evidence the admin dropped" "$COMMITTEE" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$A" "$OPERATOR" "$(hex "$EVIDENCE_A")"
    guard "C's operator disputes after C's deadline" "$OPERATOR" "$STAKING" "disputeSlash(bytes32)" "$C"
    guard "anyone expires C before it lapses" "$PASSERBY" "$STAKING" "expireSlash(bytes32)" "$C"
    ;;

  admin-day0)
    expect_state "$B" Pending B
    K=$(read_key "admin")
    echo "veto B: $(send "$K" "$STAKING" "vetoSlash(bytes32)" "$B")"
    # A is dropped only once its operator has disputed it, so the ruling is on a real dispute.
    for _ in $(seq 1 180); do [ "$(slash_state "$A")" = Disputed ] && break; echo "waiting for A's dispute..." >&2; sleep 10; done
    expect_state "$A" Disputed A
    echo "drop A (resolveDispute false): $(send "$K" "$STAKING" "resolveDispute(bytes32,bool)" "$A" false)"
    ;;

  committee-day7)
    expect_state "$A" Cancelled A
    K=$(read_key "committee")
    echo "file A again: $(send "$K" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$A" "$OPERATOR" "$(hex "$EVIDENCE_A2")")"
    echo "withdraw A:   $(send "$K" "$STAKING" "cancelSlash(bytes32)" "$A")"
    ;;

  anyone-day21)
    expect_state "$C" Pending C
    K=$(read_key "any funded")
    echo "expire C: $(send "$K" "$STAKING" "expireSlash(bytes32)" "$C")"
    guard "committee files C again at once" "$COMMITTEE" "$STAKING" "initiateSlash(bytes32,address,bytes)" "$C" "$OPERATOR" 0x01
    guard "anyone executes the lapsed C" "$PASSERBY" "$STAKING" "executeSlash(bytes32)" "$C"
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
