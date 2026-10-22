// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraOracleBond.sol";

/**
 * @title DeployOracleBond
 * @notice Deploys SigvaraOracleBond behind a UUPS proxy (tokenomics §8 oracle
 *         operator performance bonds). Governance later admits operators and grants
 *         them ORACLE_ROLE on SigvaraReputation / SigvaraEpochFees off
 *         isActiveOperator().
 *
 * Usage:
 *   forge script script/DeployOracleBond.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Do not pass --verify. Arc has no explorer entry in foundry.toml, and adding one breaks
 * forge script (docs/arc.md).
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SVR_ADDRESS          — stake-token token
 * Optional env (default to the deployer):
 *   SLASHER_ADDRESS       — granted SLASHER_ROLE (governance/committee)
 *   SLASH_BENEFICIARY     — destination for slashed bonds (defaults to deployer)
 *   ORACLE_BOND_AMOUNT    — minimum bond in wei (default 1,000 SVR; the default is refused on
 *                           mainnet, so state the number there)
 *   ORACLE_UNBONDING      — unbonding cooldown seconds (default 7 days)
 *
 * Writes the proxy address into deployments/{chainId}.json under "oracleBond", so the
 * address is recorded rather than living only in this script's console output.
 */
contract DeployOracleBond is Script {
    uint256 constant DEFAULT_BOND = 1_000e18;
    uint256 constant DEFAULT_UNBONDING = 7 days;
    uint256 constant ARC_MAINNET = 5042;

    /// The floor SigvaraOracleBond enforces in its initializer and setter. test/DeployScripts.t.sol
    /// pins it to the contract's own constant.
    uint256 constant MIN_UNBONDING = 1 days;

    error RolesNotSeparated(address deployer, address slasher, address beneficiary);
    error DefaultAmountOnMainnet(string name, uint256 value);
    error PeriodBelowFloor(string name, uint256 value, uint256 floor);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address svr        = vm.envAddress("SVR_ADDRESS");
        address slasher     = vm.envOr("SLASHER_ADDRESS", deployer);
        address beneficiary = vm.envOr("SLASH_BENEFICIARY", deployer);
        uint256 bondAmount  = vm.envOr("ORACLE_BOND_AMOUNT", DEFAULT_BOND);
        uint256 unbonding   = vm.envOr("ORACLE_UNBONDING", DEFAULT_UNBONDING);

        _checkRoleSeparation(deployer, slasher, beneficiary);
        _checkMainnetBondAmount(bondAmount);
        _checkMainnetUnbonding(unbonding);

        vm.startBroadcast(deployerKey);

        SigvaraOracleBond impl = new SigvaraOracleBond();
        SigvaraOracleBond bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SigvaraOracleBond.initialize,
                (deployer, slasher, svr, bondAmount, unbonding, beneficiary)
            )
        )));

        vm.stopBroadcast();

        require(address(bond.svr()) == svr, "svr not set");
        require(bond.bondAmount() == bondAmount, "bondAmount not set");
        require(bond.hasRole(bond.SLASHER_ROLE(), slasher), "slasher role not granted");

        console2.log("=== Sigvara OracleBond Deployment ===");
        console2.log("Chain:             ", block.chainid);
        console2.log("OracleBond proxy:  ", address(bond));
        console2.log("OracleBond impl:   ", address(impl));
        console2.log("Slasher:           ", slasher);
        console2.log("Slash beneficiary: ", beneficiary);
        console2.log("Bond amount (wei): ", bondAmount);
        console2.log("Unbonding (s):     ", unbonding);
        console2.log("SVR:              ", svr);

        _recordAddress(address(bond));
    }

    /// @dev Mainnet only. A forgotten ORACLE_BOND_AMOUNT leaves the testnet default, which is a
    ///      valid number and a very different deployment from the one intended: the bond is what
    ///      an operator stands to lose, so a figure far too low weakens the deterrent. The
    ///      admin can raise it with a setter afterwards, but the first weeks would run on the
    ///      wrong figure, so the default is refused and the number has to be stated.
    function _checkMainnetBondAmount(uint256 bondAmount) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (bondAmount == DEFAULT_BOND) revert DefaultAmountOnMainnet("ORACLE_BOND_AMOUNT", bondAmount);
    }

    /// @dev Mainnet only. The contract refuses an unbonding period under the floor itself, with
    ///      its own error. This names the variable and fails before anything is sent. With no
    ///      cooldown an operator could start to leave and withdraw before the slasher could act.
    function _checkMainnetUnbonding(uint256 unbonding) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (unbonding < MIN_UNBONDING) revert PeriodBelowFloor("ORACLE_UNBONDING", unbonding, MIN_UNBONDING);
    }

    /// @dev The deployer keeps DEFAULT_ADMIN_ROLE and UPGRADER_ROLE. If it is also the
    ///      slasher and the payee, one key can seize an operator's bond and send it to
    ///      itself, which is the opposite of a performance bond. Tolerated on testnet,
    ///      refused on mainnet, matching script/Deploy.s.sol.
    function _checkRoleSeparation(address deployer, address slasher, address beneficiary)
        internal
        view
    {
        bool slasherIsDeployer = slasher == deployer;
        bool payeeIsDeployer = beneficiary == deployer;
        if (!slasherIsDeployer && !payeeIsDeployer) return;

        if (block.chainid == ARC_MAINNET) {
            revert RolesNotSeparated(deployer, slasher, beneficiary);
        }
        console2.log("!! WARNING: roles are not separated.");
        if (slasherIsDeployer) console2.log("!!   SLASHER_ADDRESS is the deployer");
        if (payeeIsDeployer)   console2.log("!!   SLASH_BENEFICIARY is the deployer");
        console2.log("!! One key can seize an operator bond and pay itself. Testnet only.");
    }

    /// @dev Merges into the existing artifact rather than replacing it, so the registry
    ///      addresses written by script/Deploy.s.sol survive.
    ///
    ///      Only under --broadcast or --resume, so a dry run does not leave the artifact
    ///      holding a contract that was never deployed. That is not the same as after the
    ///      transactions confirm: forge executes this script locally before it sends
    ///      anything, so the file is written first. If the broadcast then fails, the file
    ///      names a contract that may not exist, and --resume runs this again from the new
    ///      nonce and rewrites it with an address that was never deployed. Check the chain
    ///      before trusting or committing it.
    function _recordAddress(address bond) internal {
        if (!_broadcasting()) {
            console2.log("Dry run: artifact not written. Re-run with --broadcast to record.");
            return;
        }

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) {
            console2.log("!! no deployments artifact at", path, "- record the address by hand");
            return;
        }
        vm.writeJson(string.concat("\"", vm.toString(bond), "\""), path, ".oracleBond");
        console2.log("Recorded in:      ", path);
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }
}
