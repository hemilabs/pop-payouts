// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "../PoPPayoutsV2.sol";

/**
 * Test harness contract that exposes internal functions for testing.
 */
contract PoPPayoutsV2Harness is PoPPayoutsV2 {
    constructor() PoPPayoutsV2() {}

    /**
     * Exposes the internal fastPow function for testing.
     */
    function exposedFastPow(uint256 num, uint256 exponent, uint256 scale) external pure returns (uint256) {
        return fastPow(num, exponent, scale);
    }
}
