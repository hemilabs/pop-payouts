// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * A contract that rejects all ETH transfers.
 * Used to test the "ETH transfer failed" branch in withdrawETH functions.
 */
contract ETHRejecter {
    // No receive() or fallback() function, so ETH transfers will fail
}
