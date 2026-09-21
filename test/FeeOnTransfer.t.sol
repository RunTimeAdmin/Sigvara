// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

/**
 * A token that takes a cut on every transfer, which is the case depositStake used to
 * account wrongly. The fee is burned rather than routed anywhere, because where it goes
 * does not matter: what matters is that the recipient receives less than was sent.
 */
contract FeeOnTransferToken is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee); // burn the cut
    }
}

/**
 * depositStake credits the measured balance delta rather than the requested amount.
 *
 * Without that, a fee-on-transfer token makes the contract book stake it never
 * received. The gap compounds with every deposit and surfaces only when the last
 * operators to withdraw find the balance short, and an agent can cross minimumStake,
 * and so become Active and slashable-for, on tokens it never transferred.
 *
 * The bond token on Arc testnet transfers exactly, so none of this is live behaviour.
 * It is here because svrToken is a plain IERC20 chosen at initialize, and the next
 * deployment picks its own.
 */
contract FeeOnTransferTest is Test, RegistrationHelper {
    FeeOnTransferToken token;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address operator  = makeAddr("operator");
    address agentAddr;
    uint256 agentPk;
    bytes32 didHash;

    bytes32 constant PUB_KEY   = bytes32(uint256(0xdeadbeef));
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant FEE_BPS   = 100; // 1%

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
        token = new FeeOnTransferToken(FEE_BPS);

        SigvaraIdentity identityImpl = new SigvaraIdentity();
        SigvaraReputation repImpl    = new SigvaraReputation();
        SigvaraStaking stakingImpl   = new SigvaraStaking();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(identityImpl),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(repImpl),
            abi.encodeCall(SigvaraReputation.initialize, (admin, address(0), address(0), committee, 7 days))
        )));
        vm.prank(admin);
        rep.initializeV3(address(identity));

        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(token), MIN_STAKE, 7 days, 7 days
            ))
        )));

        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        vm.stopPrank();

        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        token.mint(operator, 10_000e18);
        vm.prank(operator);
        token.approve(address(staking), type(uint256).max);
    }

    function test_creditsWhatArrivedNotWhatWasRequested() public {
        vm.prank(operator);
        staking.depositStake(didHash, 1000e18);

        // 1% taken in transit, so 990 arrived.
        (uint256 amount,,) = _stake(didHash);
        assertEq(amount, 990e18, "stake must equal the tokens actually received");
    }

    function test_accountingNeverExceedsTheBalanceHeld() public {
        // The property that matters. Book more than you hold and the shortfall is
        // discovered by whoever withdraws last.
        vm.startPrank(operator);
        staking.depositStake(didHash, 1000e18);
        staking.depositStake(didHash, 1000e18);
        staking.depositStake(didHash, 500e18);
        vm.stopPrank();

        (uint256 booked,,) = _stake(didHash);
        assertLe(booked, token.balanceOf(address(staking)), "booked stake exceeds tokens held");
        assertEq(booked, 2475e18, "three deposits, 1% short each");
    }

    function test_doesNotActivateOnTokensItNeverReceived() public {
        // Exactly minimumStake requested, 1% short on arrival. Activating here would
        // put an agent behind a bond that is not there.
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);

        SigvaraIdentity.AgentIdentity memory id = identity.getIdentity(didHash);
        assertTrue(
            id.status == SigvaraIdentity.AgentStatus.PendingBond,
            "must stay PendingBond when the bond fell short in transit"
        );

        // Topping up the shortfall activates it, as it should.
        vm.prank(operator);
        staking.depositStake(didHash, 20e18);
        id = identity.getIdentity(didHash);
        assertTrue(id.status == SigvaraIdentity.AgentStatus.Active, "tops up to Active");
    }

    function test_eventReportsTheCreditedAmount() public {
        vm.expectEmit(true, true, false, true);
        emit SigvaraStaking.StakeDeposited(didHash, operator, 990e18);
        vm.prank(operator);
        staking.depositStake(didHash, 1000e18);
    }

    function test_exactTokenIsUnaffected() public {
        // The delta measurement must be a no-op for a token that transfers exactly,
        // which is what both deployed networks use. Same wiring, fee switched off,
        // because a second staking core against one identity is not a thing: the
        // identity consults the core it was initialized with when checking collateral.
        token.setFee(0);

        vm.prank(operator);
        staking.depositStake(didHash, 1000e18);

        (uint256 amount,,) = _stake(didHash);
        assertEq(amount, 1000e18, "an exact token credits the full amount");
    }

    function test_mixedDepositsAccountSeparately() public {
        // A token whose fee changes between deposits still nets out to what arrived,
        // which is the point of measuring per call rather than applying a known rate.
        vm.prank(operator);
        staking.depositStake(didHash, 1000e18); // 1% -> 990

        token.setFee(500);                      // 5%
        vm.prank(operator);
        staking.depositStake(didHash, 1000e18); // -> 950

        (uint256 booked,,) = _stake(didHash);
        assertEq(booked, 1940e18);
        assertLe(booked, token.balanceOf(address(staking)), "booked stake exceeds tokens held");
    }

    function _stake(bytes32 d) internal view returns (uint256, uint256, uint256) {
        (uint256 amount, uint256 lockedAt, uint256 queued,) = staking.stakes(d);
        return (amount, lockedAt, queued);
    }
}
