// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";
import "../src/SVRToken.sol";

contract FixMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Regression tests for the security scan of 17 September 2026.
 *
 * Each test pins one fix. They are grouped here rather than scattered so the
 * set is easy to re-run against a future change, and so it is obvious what was
 * deliberately closed versus what merely happens to work.
 */
contract SecurityFixesTest is Test {
    FixMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;
    SigvaraOracleBond bond;
    SigvaraEpochFees fees;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address slasher   = makeAddr("slasher");
    address operator  = makeAddr("operator");
    address agentAddr = makeAddr("agent");
    address pool      = makeAddr("rewardPool");

    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;
    uint256 constant BOND      = 2000e18;
    uint256 constant EPOCH_FEE = 10e18;

    bytes32 didHash;

    function setUp() public {
        svr = new FixMock();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, oracle, address(0), committee, 6 hours))
        )));
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));
        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, slasher, address(svr), BOND, 7 days, admin))
        )));
        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, oracle, address(svr), address(identity), pool, EPOCH_FEE))
        )));

        vm.startPrank(admin);
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        vm.prank(operator);
        didHash = identity.registerAgent(agentAddr, bytes32(uint256(1)));

        svr.mint(operator, MIN_STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(didHash, MIN_STAKE);
        vm.stopPrank();
    }

    // ------------------------------------------------- staking: slash guards --

    /// The caller is recorded as the reporter and takes 25%. Naming itself as the
    /// victim too would make one committee signature a 50% self-payment.
    function test_fix_initiateSlash_rejectsVictimEqualsReporter() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.VictimIsReporter.selector, committee));
        vm.prank(committee);
        staking.initiateSlash(didHash, committee, "");
    }

    /// A zero challenge period would let an admin-plus-committee key execute a
    /// slash in the same block, with no window to dispute.
    function test_fix_setChallengePeriod_enforcesFloor() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 0, staking.MIN_CHALLENGE_PERIOD())
        );
        vm.prank(admin);
        staking.setChallengePeriod(0);

        // Read before the prank: an external call in the argument list consumes it.
        uint256 floor = staking.MIN_CHALLENGE_PERIOD();
        vm.prank(admin);
        staking.setChallengePeriod(floor);
        assertEq(staking.challengePeriod(), floor);
    }

    function test_fix_setUnbondingPeriod_enforcesFloor() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 0, staking.MIN_UNBONDING_PERIOD())
        );
        vm.prank(admin);
        staking.setUnbondingPeriod(0);
    }

    // --------------------------------------------------- epoch fees: deposits --

    /// Funding an unregistered didHash used to hand the balance to whoever
    /// registered that address next, because withdraw() resolves the owner lazily.
    function test_fix_depositFor_rejectsUnregisteredDid() public {
        bytes32 unknown = identity.computeDidHash(makeAddr("nobody"));
        svr.mint(operator, 100e18);
        vm.startPrank(operator);
        svr.approve(address(fees), 100e18);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AgentNotRegistered.selector, unknown));
        fees.depositFor(unknown, 100e18);
        vm.stopPrank();
    }

    function test_fix_depositFor_stillWorksForRegistered() public {
        svr.mint(operator, 100e18);
        vm.startPrank(operator);
        svr.approve(address(fees), 100e18);
        fees.depositFor(didHash, 100e18);
        vm.stopPrank();
        assertEq(fees.balance(didHash), 100e18);
    }

    // ------------------------------------------------ oracle bond: zero bond --

    /// A bond slashed to exactly zero must clear the record. Leaving a zero-bond
    /// operator in Exiting bricked the address: every recovery path reverted.
    function test_fix_slashToZero_clearsOperatorRecord() public {
        svr.mint(operator, BOND);
        vm.startPrank(operator);
        svr.approve(address(bond), BOND);
        bond.depositBond(BOND);
        vm.stopPrank();

        vm.prank(admin);
        bond.admit(operator);

        vm.prank(operator);
        bond.initiateUnbond();

        vm.prank(slasher);
        bond.slash(operator, BOND);

        assertEq(bond.bondOf(operator), 0);
        assertFalse(bond.isActiveOperator(operator));

        // The address must be reusable rather than permanently stuck.
        svr.mint(operator, BOND);
        vm.startPrank(operator);
        svr.approve(address(bond), BOND);
        bond.depositBond(BOND);
        vm.stopPrank();
        assertEq(bond.bondOf(operator), BOND, "operator could not re-bond after a full slash");
    }

    // --------------------------------------------------------- SVRToken faucet --

    /// The faucet treated a first-time caller as having last used it at epoch 0,
    /// so it reverted on any chain whose clock was below one day. Anvil starts at 1.
    function test_fix_faucet_worksOnAYoungChain() public {
        SVRToken token = new SVRToken(admin);
        vm.warp(1000); // younger than FAUCET_COOLDOWN
        address user = makeAddr("faucetUser");
        vm.prank(user);
        token.faucet(1000e18);
        assertEq(token.balanceOf(user), 1000e18);

        // The cooldown itself must still bite on the second call.
        vm.prank(user);
        vm.expectRevert();
        token.faucet(1000e18);
    }
}
