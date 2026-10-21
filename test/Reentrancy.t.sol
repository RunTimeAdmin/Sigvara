// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";

/**
 * A token that calls back into a chosen contract in the middle of a transfer.
 *
 * Every function that moves the bond token is guarded by nonReentrant, and until these
 * tests nothing checked the guards. Removing one, or forgetting it on the next function
 * that moves tokens, changed no other test's result: the bond token on Arc is a plain
 * ERC-20 with no callbacks, so no ordinary test can reach a re-entrant call. This one can.
 *
 * It is armed for one callback, for either direction of transfer. The callback is made by
 * the token itself, so it carries no authority and would be refused by the target's own
 * checks if it got that far. The tests therefore expect the guard's error specifically,
 * which is what tells "the guard stopped it" from "something else did".
 */
contract ReentrantToken is ERC20 {
    enum Hook { None, OnTransferFrom, OnTransfer }

    Hook public hook;
    address public target;
    bytes public payload;

    constructor() ERC20("Hostile", "HOST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(Hook hook_, address target_, bytes calldata payload_) external {
        hook = hook_;
        target = target_;
        payload = payload_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _callBack(Hook.OnTransferFrom);
        return super.transferFrom(from, to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _callBack(Hook.OnTransfer);
        return super.transfer(to, value);
    }

    function _callBack(Hook when) internal {
        if (hook != when) return;
        hook = Hook.None; // one shot, so the callback cannot recurse into itself
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            // Hand the target's revert back to the caller untouched.
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

// OpenZeppelin's error for a call that arrives while a guarded function is running.
bytes4 constant REENTRANCY = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

contract StakingReentrancyTest is Test, RegistrationHelper {
    ReentrantToken token;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address operator  = makeAddr("operator");
    address victim    = makeAddr("victim");
    address agentAddr;
    uint256 agentPk;
    bytes32 didHash;

    bytes32 constant PUB_KEY   = bytes32(uint256(0xdeadbeef));
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 7 days;

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
        token = new ReentrantToken();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, address(0), address(0), committee, 1 hours))
        )));
        vm.prank(admin);
        rep.initializeV3(address(identity));

        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(token), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));

        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        token.mint(operator, 10_000e18);
        vm.prank(operator);
        token.approve(address(staking), type(uint256).max);
    }

    function _deposit() internal {
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE * 2);
    }

    /// Tokens arrive in the middle of this call, and the credited amount is read from the
    /// balance before and after. A nested deposit would be counted twice.
    function test_depositStake_refusesACallBackFromTheToken() public {
        token.arm(
            ReentrantToken.Hook.OnTransferFrom,
            address(staking),
            abi.encodeCall(SigvaraStaking.depositStake, (didHash, 1e18))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
    }

    function test_claimWithdrawal_refusesACallBackFromTheToken() public {
        _deposit();
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
        vm.warp(block.timestamp + UNBONDING + 1);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(staking),
            abi.encodeCall(SigvaraStaking.claimWithdrawal, (didHash))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    function test_executeSlash_refusesACallBackFromTheBurnTransfer() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + CHALLENGE + 1);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(staking),
            abi.encodeCall(SigvaraStaking.executeSlash, (didHash))
        );

        vm.expectRevert(REENTRANCY);
        staking.executeSlash(didHash);
    }

    function test_resolveDispute_refusesACallBackFromTheBurnTransfer() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(staking),
            abi.encodeCall(SigvaraStaking.resolveDispute, (didHash, true))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(committee);
        staking.resolveDispute(didHash, true);
    }

    function test_claimSlashProceeds_refusesACallBackFromTheToken() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);
        assertGt(staking.claimable(victim), 0, "setup: the victim has proceeds to claim");

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(staking),
            abi.encodeCall(SigvaraStaking.claimSlashProceeds, ())
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(victim);
        staking.claimSlashProceeds();
    }
}

contract EpochFeesReentrancyTest is Test, RegistrationHelper {
    ReentrantToken token;
    SigvaraIdentity identity;
    SigvaraEpochFees fees;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");
    address funder   = makeAddr("funder");
    address agentAddr;
    uint256 agentPk;
    bytes32 didHash;

    bytes32 constant PUB_KEY = bytes32(uint256(0xbeef));

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
        token = new ReentrantToken();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (
                admin, admin, address(token), address(identity), makeAddr("rewardPool"), 1e18
            ))
        )));

        token.mint(funder, 10_000e18);
        vm.prank(funder);
        token.approve(address(fees), type(uint256).max);
    }

    function test_depositFor_refusesACallBackFromTheToken() public {
        token.arm(
            ReentrantToken.Hook.OnTransferFrom,
            address(fees),
            abi.encodeCall(SigvaraEpochFees.depositFor, (didHash, 1e18))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(funder);
        fees.depositFor(didHash, 100e18);
    }

    function test_withdraw_refusesACallBackFromTheToken() public {
        vm.prank(funder);
        fees.depositFor(didHash, 100e18);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(fees),
            abi.encodeCall(SigvaraEpochFees.withdraw, (didHash, 1e18))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(operator);
        fees.withdraw(didHash, 50e18);
    }

    function test_distributeFees_refusesACallBackFromTheToken() public {
        vm.prank(funder);
        fees.depositFor(didHash, 10e18);
        vm.prank(admin);
        fees.chargeEpoch(didHash);
        assertGt(fees.collected(), 0, "setup: there are fees to distribute");

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(fees),
            abi.encodeCall(SigvaraEpochFees.distributeFees, ())
        );

        vm.expectRevert(REENTRANCY);
        fees.distributeFees();
    }
}

contract OracleBondReentrancyTest is Test {
    ReentrantToken token;
    SigvaraOracleBond bondReg;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");

    uint256 constant BOND      = 1000e18;
    uint256 constant UNBONDING = 7 days;

    function setUp() public {
        token = new ReentrantToken();

        bondReg = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (
                admin, admin, address(token), BOND, UNBONDING, makeAddr("slashBeneficiary")
            ))
        )));

        token.mint(operator, 10_000e18);
        vm.prank(operator);
        token.approve(address(bondReg), type(uint256).max);
    }

    function test_depositBond_refusesACallBackFromTheToken() public {
        token.arm(
            ReentrantToken.Hook.OnTransferFrom,
            address(bondReg),
            abi.encodeCall(SigvaraOracleBond.depositBond, (1e18))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(operator);
        bondReg.depositBond(BOND);
    }

    function test_withdrawBond_refusesACallBackFromTheToken() public {
        vm.startPrank(operator);
        bondReg.depositBond(BOND);
        bondReg.initiateUnbond();
        vm.stopPrank();
        vm.warp(block.timestamp + UNBONDING + 1);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(bondReg),
            abi.encodeCall(SigvaraOracleBond.withdrawBond, ())
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(operator);
        bondReg.withdrawBond();
    }

    function test_slash_refusesACallBackFromTheToken() public {
        vm.prank(operator);
        bondReg.depositBond(BOND);

        token.arm(
            ReentrantToken.Hook.OnTransfer,
            address(bondReg),
            abi.encodeCall(SigvaraOracleBond.slash, (operator, 1e18))
        );

        vm.expectRevert(REENTRANCY);
        vm.prank(admin);
        bondReg.slash(operator, 100e18);
    }
}
