// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../../src/SigvaraIdentity.sol";
import "../../src/SigvaraReputation.sol";
import "../../src/SigvaraStaking.sol";
import "../../src/SigvaraReader.sol";

/// A plain ERC-20 standing in for the bond token.
contract FixtureToken is ERC20 {
    constructor() ERC20("Bond", "BOND") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * The three registries behind proxies and wired the way the deploy scripts wire them,
 * a funded operator, and a SigvaraReader pointed at them. Tests that read an agent's
 * standing need the whole stack, and each used to carry its own copy of this setup.
 */
abstract contract StackFixture is Test, RegistrationHelper {
    FixtureToken internal svr;
    SigvaraIdentity internal identity;
    SigvaraReputation internal reputation;
    SigvaraStaking internal staking;
    SigvaraReader internal reader;

    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address internal committee = makeAddr("committee");
    address internal operator = makeAddr("operator");
    address internal victim = makeAddr("victim");

    uint256 internal constant MIN_STAKE = 1000e18;
    uint256 internal constant SCORE_WINDOW = 1 hours;
    uint256 internal constant SLASH_WINDOW = 7 days;
    uint256 internal constant UNBONDING = 21 days;

    bytes32 internal constant PUB_KEY = bytes32(uint256(0xdeadbeef));

    function _deployStack() internal {
        svr = new FixtureToken();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));

        reputation = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (
                admin,
                oracle,
                address(0),
                committee,
                SCORE_WINDOW
            ))
        )));
        vm.prank(admin);
        reputation.initializeV3(address(identity));

        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin,
                address(identity),
                address(reputation),
                address(svr),
                MIN_STAKE,
                SLASH_WINDOW,
                UNBONDING
            ))
        )));

        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        reputation.grantRole(reputation.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        svr.mint(operator, 100_000e18);
        vm.prank(operator);
        svr.approve(address(staking), type(uint256).max);

        reader = new SigvaraReader(address(identity), address(reputation), address(staking));
    }

    /// Registers the address behind `agentPk` under `operator` and posts a bond of `amount`.
    function _registerAndBond(uint256 agentPk, uint256 amount) internal returns (bytes32 didHash) {
        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);
        vm.prank(operator);
        staking.depositStake(didHash, amount);
    }

    /// Has the oracle propose `data`, then finalizes it once the challenge window closes.
    function _finalize(bytes32 didHash, SigvaraReputation.ReputationData memory data) internal {
        vm.prank(oracle);
        reputation.proposeReputation(didHash, data, bytes32(0));
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(didHash);
    }

    /// A score of 40: fee 10, success 8, tenure 12, community 5, propagation 5.
    function _score40() internal pure returns (SigvaraReputation.ReputationData memory) {
        return SigvaraReputation.ReputationData({
            feeScore: 10,
            successScore: 8,
            ageScore: 12,
            externalScore: 0,
            communityScore: 5,
            propagationScore: 5,
            lastUpdated: 0
        });
    }
}
