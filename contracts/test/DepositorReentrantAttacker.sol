// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * Interface for the mintPoPRewards function we want to reenter.
 */
interface IPoPPayoutsV2Reentrancy {
    function mintPoPRewards(
        uint64 _blockRewarded,
        address[] calldata _accounts,
        uint32[] calldata _relPubHeights
    ) external;
}

/**
 * @title DepositorReentrantAttacker
 * @notice Test contract deployed at DEPOSITOR_ACCOUNT (0x888...888) via hardhat_setCode
 *         to verify the nonReentrant modifier on mintPoPRewards works correctly.
 *
 * IMPORTANT: In production, no contract can be deployed at the DEPOSITOR_ACCOUNT address
 * (it's a protocol-controlled constant). This test uses hardhat_setCode to bypass normal
 * deployment and verify the nonReentrant modifier works as defense-in-depth.
 *
 * Attack flow:
 * 1. This contract's bytecode is placed at DEPOSITOR_ACCOUNT via hardhat_setCode
 * 2. It calls mintPoPRewards with itself as a recipient
 * 3. The malicious HEMI token calls onTokenReceived() during transfer
 * 4. This contract attempts reentrant call to mintPoPRewards (blocked by nonReentrant)
 */
contract DepositorReentrantAttacker {
    address public targetContract;
    uint64 public reentrantBlockRewarded;
    bool public attackEnabled;
    bool public attackAttempted;
    bool public reentrancySucceeded;

    event ReentrancyAttempted(bool success, string reason);
    event AttackInitiated(address target, uint64 blockRewarded);

    /**
     * @notice Configure the attack parameters
     * @param _targetContract The PoPPayoutsV2 contract to attack
     * @param _reentrantBlockRewarded The block height to use in the reentrant call
     */
    function setAttackParams(
        address _targetContract,
        uint64 _reentrantBlockRewarded
    ) external {
        targetContract = _targetContract;
        reentrantBlockRewarded = _reentrantBlockRewarded;
        attackEnabled = true;
        attackAttempted = false;
        reentrancySucceeded = false;
    }

    /**
     * @notice Initiate the attack by calling mintPoPRewards
     * @param _blockRewarded The block height to reward
     * @param _accounts The accounts to reward (should include this contract's address)
     * @param _relPubHeights The relative publication heights
     */
    function initiateAttack(
        uint64 _blockRewarded,
        address[] calldata _accounts,
        uint32[] calldata _relPubHeights
    ) external {
        emit AttackInitiated(targetContract, _blockRewarded);
        IPoPPayoutsV2Reentrancy(targetContract).mintPoPRewards(
            _blockRewarded,
            _accounts,
            _relPubHeights
        );
    }

    /**
     * @notice Called by the malicious HEMI token during transfer.
     *         This is where we attempt the reentrant call.
     */
    function onTokenReceived() external {
        if (attackEnabled && !attackAttempted && targetContract != address(0)) {
            attackAttempted = true;

            // Prepare reentrant call parameters
            address[] memory accounts = new address[](1);
            accounts[0] = address(0x1234567890123456789012345678901234567890);

            uint32[] memory heights = new uint32[](1);
            heights[0] = 0;

            // Attempt reentrant call - should fail due to nonReentrant modifier
            // Since we ARE the depositor, onlyDepositor will pass
            try IPoPPayoutsV2Reentrancy(targetContract).mintPoPRewards(
                reentrantBlockRewarded,
                accounts,
                heights
            ) {
                // If we get here, reentrancy protection FAILED!
                reentrancySucceeded = true;
                emit ReentrancyAttempted(true, "Reentrancy succeeded - THIS IS BAD!");
            } catch Error(string memory reason) {
                // Expected: should be blocked by nonReentrant
                emit ReentrancyAttempted(false, reason);
            } catch (bytes memory) {
                // Low-level revert (ReentrancyGuardReentrantCall custom error)
                emit ReentrancyAttempted(false, "Low-level revert (expected: ReentrancyGuardReentrantCall)");
            }
        }
    }

    /**
     * @notice Fallback to handle any unexpected calls
     */
    receive() external payable {}
    fallback() external payable {}
}
