// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SVRToken.sol";

/// Drives the bond registry with arbitrary sequences over a small set of addresses, every one
/// of which can be an operator, a signer, or neither, so that collisions between the roles are
/// the common case rather than a rare one. Calls that the contract refuses are swallowed: the
/// refusals are the behaviour under test, and the invariants say what must hold whatever was
/// accepted.
contract OracleBondHandler is Test {
    SigvaraOracleBond public bond;
    SVRToken public svr;
    address public admin;
    address public slasher;
    address[] public actors;

    constructor(SigvaraOracleBond bond_, SVRToken svr_, address admin_, address slasher_) {
        bond = bond_;
        svr = svr_;
        admin = admin_;
        slasher = slasher_;
        for (uint256 i = 0; i < 6; i++) actors.push(makeAddr(string.concat("actor", vm.toString(i))));
    }

    function actorCount() external view returns (uint256) { return actors.length; }

    function _a(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    function deposit(uint256 who, uint256 amount) external {
        address a = _a(who);
        amount = bound(amount, 1, 3_000e18);
        svr.mint(a, amount);
        vm.startPrank(a);
        svr.approve(address(bond), amount);
        try bond.depositBond(amount) {} catch {}
        vm.stopPrank();
    }

    function admit(uint256 who) external {
        vm.prank(admin);
        try bond.admit(_a(who)) {} catch {}
    }

    function remove(uint256 who) external {
        vm.prank(admin);
        try bond.removeOperator(_a(who)) {} catch {}
    }

    function setSigner(uint256 who, uint256 signer) external {
        vm.prank(_a(who));
        try bond.setSigner(_a(signer)) {} catch {}
    }

    function clearSigner(uint256 who) external {
        vm.prank(_a(who));
        try bond.clearSigner() {} catch {}
    }

    function unbond(uint256 who) external {
        vm.prank(_a(who));
        try bond.initiateUnbond() {} catch {}
    }

    function withdraw(uint256 who) external {
        vm.warp(block.timestamp + bond.unbondingPeriod() + 1);
        vm.prank(_a(who));
        try bond.withdrawBond() {} catch {}
    }

    function slash(uint256 who, uint256 amount) external {
        address a = _a(who);
        uint256 held = bond.bondOf(a);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(slasher);
        try bond.slash(a, amount) {} catch {}
    }

    function setBondAmount(uint256 amount) external {
        vm.prank(admin);
        try bond.setBondAmount(bound(amount, 1, 4_000e18)) {} catch {}
    }
}

contract OracleBondInvariantTest is Test {
    SigvaraOracleBond bond;
    SVRToken svr;
    OracleBondHandler handler;

    function setUp() public {
        address admin = makeAddr("admin");
        address slasher = makeAddr("slasher");
        svr = new SVRToken(address(this));
        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(
                SigvaraOracleBond.initialize,
                (admin, slasher, address(svr), 1000e18, 7 days, makeAddr("beneficiary"))
            )
        )));
        handler = new OracleBondHandler(bond, svr, admin, slasher);
        // The handler mints each caller what it deposits. Without ownership its first call
        // reverts, every sequence is empty, and the invariants below hold of nothing.
        svr.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    /// The plumbing works: the handler can fund an actor, have it admitted and name a signer.
    /// This is here because the campaign once ran for 128,000 calls without a single deposit
    /// succeeding, and every invariant passed.
    function test_theHandlerActuallyReachesOperatorsAndSigners() public {
        handler.deposit(0, 2_000e18);
        handler.admit(0);
        handler.setSigner(0, 1);
        address op = handler.actors(0);
        address signer = handler.actors(1);
        assertEq(bond.signerOf(op), signer);
        assertEq(bond.operatorOfSigner(signer), op);
        assertTrue(bond.isActiveOperator(signer));
        assertEq(bond.bondOf(op), 2_000e18);
    }

    function _status(address a) internal view returns (SigvaraOracleBond.Status s) {
        (, s,) = bond.operators(a);
    }

    /// A signer and its operator name each other, or neither names anything.
    function invariant_signerMappingsAreSymmetric() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            address signer = bond.signerOf(a);
            if (signer != address(0)) assertEq(bond.operatorOfSigner(signer), a, "signerOf without its reverse");
            address op = bond.operatorOfSigner(a);
            if (op != address(0)) assertEq(bond.signerOf(op), a, "operatorOfSigner without its reverse");
        }
    }

    /// No address is both a signer and a participant in its own right. Otherwise
    /// isActiveOperator could not say which of the two it was answering for.
    function invariant_aSignerIsNotAlsoAnOperator() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            if (bond.operatorOfSigner(a) == address(0)) continue;
            assertEq(uint8(_status(a)), uint8(SigvaraOracleBond.Status.None), "a signer holds a bond record");
            assertEq(bond.bondOf(a), 0, "a signer holds a bond");
            assertEq(bond.signerOf(a), address(0), "a signer names a signer");
        }
    }

    /// An address is active only because it, or the operator it signs for, is Active with the
    /// required bond. Nothing else makes an address active.
    function invariant_standingComesOnlyFromABondedActiveOperator() public view {
        uint256 required = bond.bondAmount();
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            address op = bond.operatorOfSigner(a);
            if (op == address(0)) op = a;
            bool expected = _status(op) == SigvaraOracleBond.Status.Active && bond.bondOf(op) >= required;
            assertEq(bond.isActiveOperator(a), expected, "standing differs from the operator's");
        }
    }

    /// An operator that has left for good has no signer left behind.
    function invariant_nobodyIsLeftSigningForNobody() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            if (_status(a) == SigvaraOracleBond.Status.None) {
                assertEq(bond.signerOf(a), address(0), "a signer outlived its operator's record");
            }
        }
    }

    /// The existing accounting still holds with signers in the picture.
    function invariant_activeCountAndCustodyStillAddUp() public view {
        uint256 active;
        uint256 owed;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            if (_status(a) == SigvaraOracleBond.Status.Active) active++;
            owed += bond.bondOf(a);
        }
        assertEq(bond.activeCount(), active, "activeCount");
        assertEq(svr.balanceOf(address(bond)), owed, "the registry holds exactly what it owes");
    }
}
