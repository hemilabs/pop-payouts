// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "../PoPPayoutsV2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A malicious ERC20 token that attempts reentrancy during transfer.
 * Used to test the nonReentrant modifier on _withdrawFundsImpl.
 */
contract MaliciousReentrantERC20 is ERC20 {
    PoPPayoutsV2 public targetContract;
    address public attackDestination;
    uint256 public attackAmount;
    bool public attackEnabled;
    bool public attackAttempted;

    event ReentrancyAttempted(bool success, bytes returnData);

    constructor(address receiver, uint256 initialSupply) ERC20("MaliciousToken", "MAL") {
        _mint(receiver, initialSupply);
    }

    /**
     * Configure the reentrancy attack parameters.
     */
    function setAttackParams(
        address payable _targetContract,
        address _attackDestination,
        uint256 _attackAmount
    ) external {
        targetContract = PoPPayoutsV2(_targetContract);
        attackDestination = _attackDestination;
        attackAmount = _attackAmount;
        attackEnabled = true;
        attackAttempted = false;
    }

    /**
     * Override transfer to attempt reentrancy when attackEnabled is true.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        // Do the actual transfer first
        bool success = super.transfer(to, amount);

        // Attempt reentrancy attack if enabled and not already attempted
        if (attackEnabled && !attackAttempted) {
            attackAttempted = true;

            // Try to call withdrawFunds again (should fail due to nonReentrant)
            // Cast this contract to ERC20 type for the function call
            try targetContract.withdrawFunds(
                ERC20(address(this)),
                attackAmount,
                attackDestination
            ) {
                // If we get here, reentrancy protection failed!
                emit ReentrancyAttempted(true, "");
            } catch (bytes memory returnData) {
                // Expected: reentrancy should be blocked
                emit ReentrancyAttempted(false, returnData);
            }
        }

        return success;
    }
}
