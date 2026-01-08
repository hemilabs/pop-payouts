// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Interface for the mintPoPRewards function we want to reenter.
 */
interface IPoPPayoutsV2 {
    function mintPoPRewards(
        uint64 _blockRewarded,
        address[] calldata _accounts,
        uint32[] calldata _relPubHeights
    ) external;
}

/**
 * A malicious Hemi token that attempts reentrancy during transfer.
 * Used to test the nonReentrant modifier on mintPoPRewards.
 *
 * When transfer is called during mintPoPRewards reward distribution,
 * this contract attempts to call mintPoPRewards again.
 */
contract MaliciousReentrantHemi is ERC20 {
    address public targetContract;
    uint64 public attackBlockRewarded;
    bool public attackEnabled;
    bool public attackAttempted;
    bool public reentrancySucceeded;

    event ReentrancyAttempted(bool success, string reason);

    constructor(address receiver, uint256 initialSupply) ERC20("Malicious Hemi", "mHEMI") {
        _mint(receiver, initialSupply);
    }

    /**
     * Configure the reentrancy attack parameters.
     */
    function setAttackParams(
        address _targetContract,
        uint64 _attackBlockRewarded
    ) external {
        targetContract = _targetContract;
        attackBlockRewarded = _attackBlockRewarded;
        attackEnabled = true;
        attackAttempted = false;
        reentrancySucceeded = false;
    }

    /**
     * Disable the attack (useful after first transfer to avoid infinite recursion attempts).
     */
    function disableAttack() external {
        attackEnabled = false;
    }

    /**
     * Override transfer to attempt reentrancy when enabled.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        // Do the actual transfer first
        bool success = super.transfer(to, amount);

        // Attempt reentrancy attack if enabled and not already attempted
        if (attackEnabled && !attackAttempted && targetContract != address(0)) {
            attackAttempted = true;

            // Prepare attack parameters - try to call mintPoPRewards again
            address[] memory accounts = new address[](1);
            accounts[0] = address(0x1234567890123456789012345678901234567890);

            uint32[] memory heights = new uint32[](1);
            heights[0] = 0;

            // Try to call mintPoPRewards again (should fail due to nonReentrant)
            try IPoPPayoutsV2(targetContract).mintPoPRewards(
                attackBlockRewarded,
                accounts,
                heights
            ) {
                // If we get here, reentrancy protection failed!
                reentrancySucceeded = true;
                emit ReentrancyAttempted(true, "Reentrancy succeeded - THIS IS BAD!");
            } catch Error(string memory reason) {
                // Expected: reentrancy should be blocked
                emit ReentrancyAttempted(false, reason);
            } catch (bytes memory) {
                // Low-level revert
                emit ReentrancyAttempted(false, "Low-level revert");
            }
        }

        return success;
    }
}
