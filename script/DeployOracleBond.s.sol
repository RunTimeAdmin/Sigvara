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
 *   forge script script/DeployOracleBond.s.sol --rpc-url $RPC --broadcast --verify -vvvv
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SVR_ADDRESS          — stake-token token
 * Optional env (default to the deployer):
 *   SLASHER_ADDRESS       — granted SLASHER_ROLE (governance/committee)
 *   SLASH_BENEFICIARY     — destination for slashed bonds (defaults to deployer)
 *   ORACLE_BOND_AMOUNT    — minimum bond in wei (default 1,000 SVR)
 *   ORACLE_UNBONDING      — unbonding cooldown seconds (default 7 days)
 *
 * Writes the proxy address into deployments/{chainId}.json under "oracleBond", so the
 * address is recorded rather than living only in this script's console output.
 */
contract DeployOracleBond is Script {
    uint256 constant DEFAULT_BOND = 1_000e18;
    uint256 constant DEFAULT_UNBONDING = 7 days;
    uint256 constant ARC_MAINNET = 5042;

    error RolesNotSeparated(address deployer, address slasher, address beneficiary);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address svr        = vm.envAddress("SVR_ADDRESS");
        address slasher     = vm.envOr("SLASHER_ADDRESS", deployer);
        address beneficiary = vm.envOr("SLASH_BENEFICIARY", deployer);
        uint256 bondAmount  = vm.envOr("ORACLE_BOND_AMOUNT", DEFAULT_BOND);
        uint256 unbonding   = vm.envOr("ORACLE_UNBONDING", DEFAULT_UNBONDING);

        _checkRoleSeparation(deployer, slasher, beneficiary);

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
    function _recordAddress(address bond) internal {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) {
            console2.log("!! no deployments artifact at", path, "- record the address by hand");
            return;
        }
        vm.writeJson(string.concat("\"", vm.toString(bond), "\""), path, ".oracleBond");
        console2.log("Recorded in:      ", path);
    }
}
