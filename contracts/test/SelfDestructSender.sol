// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * A helper contract that can force-send ETH to any address via selfdestruct.
 * Used for testing ETH recovery functionality when ETH is force-sent to a contract.
 */
contract SelfDestructSender {
    constructor() payable {}

    function destroy(address payable recipient) external {
        selfdestruct(recipient);
    }
}
