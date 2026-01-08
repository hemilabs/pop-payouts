// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * Interface for the withdrawETH functions we want to reenter.
 */
interface IPoPPayoutsV2ETH {
    function withdrawETH(uint256 amount, address payable destinationAddress) external;
    function protocolForceWithdrawETH(uint256 amount, address payable destinationAddress) external;
}

/**
 * A contract that attempts reentrancy when receiving ETH.
 * Used to test the nonReentrant modifier on withdrawETH functions.
 * Does NOT catch errors - lets ReentrancyGuardReentrantCall propagate up.
 */
contract ReentrantETHReceiver {
    address public targetContract;
    bool public attackEnabled;

    function setTarget(address _target) external {
        targetContract = _target;
    }

    function enableAttack() external {
        attackEnabled = true;
    }

    function disableAttack() external {
        attackEnabled = false;
    }

    /**
     * Called when this contract receives ETH.
     * Attempts to reenter withdrawETH if attack is enabled.
     * Does NOT catch the error - lets it propagate up.
     */
    receive() external payable {
        if (attackEnabled) {
            attackEnabled = false; // Prevent infinite loop

            // Attempt to reenter withdrawETH - will revert with ReentrancyGuardReentrantCall
            IPoPPayoutsV2ETH(targetContract).withdrawETH(
                0.1 ether,
                payable(address(this))
            );
        }
    }
}
