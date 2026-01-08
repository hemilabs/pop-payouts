// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Interface for the attacker contract deployed at the depositor address.
 */
interface IDepositorAttacker {
    function onTokenReceived() external;
}

/**
 * @title CallbackMaliciousHemi
 * @notice Test ERC20 that calls back to the depositor address during transfer.
 *
 * Used with DepositorReentrantAttacker to test the nonReentrant modifier on mintPoPRewards.
 * When tokens are transferred to the callback target, this contract calls onTokenReceived()
 * which triggers the reentrancy attempt.
 *
 * See DepositorReentrantAttacker.sol for details on why this test scenario is impossible
 * in production but useful for verifying defense-in-depth.
 */
contract CallbackMaliciousHemi is ERC20 {
    address public callbackTarget;
    bool public callbackEnabled;
    bool public callbackAttempted;

    event CallbackTriggered(address target);

    constructor(address receiver, uint256 initialSupply) ERC20("Callback Malicious Hemi", "cmHEMI") {
        _mint(receiver, initialSupply);
    }

    /**
     * @notice Set the callback target (should be the depositor address with attacker contract)
     */
    function setCallbackTarget(address _target) external {
        callbackTarget = _target;
        callbackEnabled = true;
        callbackAttempted = false;
    }

    /**
     * @notice Disable callbacks
     */
    function disableCallback() external {
        callbackEnabled = false;
    }

    /**
     * @notice Override transfer to call back to the depositor during transfer
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        // Do the actual transfer first
        bool success = super.transfer(to, amount);

        // If transferring to the callback target (depositor), trigger the callback
        // Only do this once to avoid infinite loops
        if (callbackEnabled && !callbackAttempted && to == callbackTarget) {
            callbackAttempted = true;
            emit CallbackTriggered(callbackTarget);

            // Call back to the depositor's attacker contract
            IDepositorAttacker(callbackTarget).onTokenReceived();
        }

        return success;
    }
}
