// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A mock ERC20 token that can be configured to revert after N successful transfers.
 * Used to test state consistency when ERC20 transfers fail mid-distribution.
 */
contract MockRevertingERC20 is ERC20 {
    uint256 public transferCount;
    uint256 public failAfterTransfers;
    bool public shouldFail;

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply);
        failAfterTransfers = type(uint256).max; // Never fail by default
        shouldFail = false;
    }

    /**
     * Configure the token to revert after N successful transfers.
     * @param n The number of transfers to allow before reverting
     */
    function setFailAfterTransfers(uint256 n) external {
        failAfterTransfers = n;
        transferCount = 0;
    }

    /**
     * Configure the token to always fail transfers.
     */
    function setAlwaysFail(bool fail) external {
        shouldFail = fail;
    }

    /**
     * Reset the transfer counter.
     */
    function resetTransferCount() external {
        transferCount = 0;
    }

    /**
     * Override transfer to conditionally revert.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (shouldFail) {
            revert("MockRevertingERC20: transfer failed");
        }
        if (transferCount >= failAfterTransfers) {
            revert("MockRevertingERC20: transfer limit exceeded");
        }
        transferCount++;
        return super.transfer(to, amount);
    }

    /**
     * Override transferFrom to conditionally revert.
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (shouldFail) {
            revert("MockRevertingERC20: transferFrom failed");
        }
        if (transferCount >= failAfterTransfers) {
            revert("MockRevertingERC20: transfer limit exceeded");
        }
        transferCount++;
        return super.transferFrom(from, to, amount);
    }
}
