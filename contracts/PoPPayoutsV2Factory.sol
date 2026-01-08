// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "./PoPPayoutsV2.sol";

/**
 * Factory contract for deploying PoPPayoutsV2 with deterministic CREATE2 addresses.
 *
 * This factory enables atomic deployment and initialization, preventing front-running
 * attacks where an attacker could initialize the contract before the legitimate deployer.
 *
 * The factory itself should be deployed via CREATE2 to the same address on all networks,
 * enabling fully deterministic PoPPayoutsV2 addresses across chains.
 */
contract PoPPayoutsV2Factory {
    event PoPPayoutsV2Deployed(
        address indexed deployedAddress,
        address indexed owner,
        address indexed supplyOwner,
        bytes32 salt
    );

    /**
     * Deploys a new PoPPayoutsV2 contract using CREATE2 and initializes it atomically.
     * This prevents front-running of the initialization.
     *
     * The deployed address is deterministic based only on the salt (and factory address),
     * regardless of the initialization parameters.
     *
     * @param salt The salt for CREATE2 deployment (determines the deployed address)
     * @param owner The initial owner of the contract
     * @param supplyOwner The initial supply owner of the contract
     * @param hemiTokenContract The address of the $HEMI token contract
     * @param initialSupply The initial total supply of the $HEMI token
     * @param initialInflationYearly The initial annual inflation rate in BPS
     * @param popInflationAllocation The PoP allocation from inflation in BPS
     * @param supplyTimestamp The timestamp from which supply inflation begins
     * @param firstRoundRewards The initial rewards for the first payout round
     * @return deployed The address of the deployed PoPPayoutsV2 contract
     */
    function deployAndInitialize(
        bytes32 salt,
        address owner,
        address supplyOwner,
        address hemiTokenContract,
        uint256 initialSupply,
        uint256 initialInflationYearly,
        uint256 popInflationAllocation,
        uint256 supplyTimestamp,
        uint256 firstRoundRewards
    ) external returns (address deployed) {
        // Deploy using CREATE2 (no constructor args = deterministic address based only on salt)
        PoPPayoutsV2 popPayouts = new PoPPayoutsV2{salt: salt}();

        // Initialize atomically (same transaction, no front-running possible)
        popPayouts.initialize(
            owner,
            supplyOwner,
            hemiTokenContract,
            initialSupply,
            initialInflationYearly,
            popInflationAllocation,
            supplyTimestamp,
            firstRoundRewards
        );

        deployed = address(popPayouts);
        emit PoPPayoutsV2Deployed(deployed, owner, supplyOwner, salt);
    }

    /**
     * Computes the address where a PoPPayoutsV2 contract would be deployed with the given salt.
     * The address is deterministic and independent of initialization parameters.
     *
     * @param salt The salt for CREATE2 deployment
     * @return The address where the contract would be deployed
     */
    function computeAddress(bytes32 salt) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(type(PoPPayoutsV2).creationCode)
            )
        );

        return address(uint160(uint256(hash)));
    }
}
