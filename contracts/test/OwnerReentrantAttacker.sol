// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "../PoPPayoutsV2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A contract that is BOTH an ERC20 token AND can be set as owner.
 * This allows testing the nonReentrant modifier by having the owner
 * (this contract) call withdrawFunds, which transfers tokens, and
 * during that transfer, this contract attempts to reenter.
 */
contract OwnerReentrantAttacker is ERC20 {
    PoPPayoutsV2 public targetContract;
    bool public attackEnabled;
    uint256 public attackCount;

    constructor() ERC20("AttackerToken", "ATK") {
        // Mint tokens to self
        _mint(address(this), 1000000 * 1e18);
    }

    function setTarget(address payable _target) external {
        targetContract = PoPPayoutsV2(_target);
    }

    function initializeContract(
        address payable _target,
        address _owner,
        address _supplyOwner,
        address _hemiToken,
        uint256 _initialSupply,
        uint256 _initialInflationYearly,
        uint256 _popInflationAllocation,
        uint256 _supplyTimestamp,
        uint256 _firstRoundRewards
    ) external {
        PoPPayoutsV2(_target).initialize(
            _owner,
            _supplyOwner,
            _hemiToken,
            _initialSupply,
            _initialInflationYearly,
            _popInflationAllocation,
            _supplyTimestamp,
            _firstRoundRewards
        );
    }

    function enableAttack() external {
        attackEnabled = true;
        attackCount = 0;
    }

    function fundTarget(uint256 amount) external {
        // Transfer tokens to the PoPPayoutsV2 contract
        _transfer(address(this), address(targetContract), amount);
    }

    /**
     * Execute the attack: call withdrawFunds which will transfer tokens.
     * During the transfer, if attack is enabled, we try to reenter.
     */
    function executeWithdraw(uint256 amount, address destination) external {
        targetContract.withdrawFunds(ERC20(address(this)), amount, destination);
    }

    /**
     * Override transfer to attempt reentrancy when enabled.
     * No try/catch - let the ReentrancyGuardReentrantCall error propagate.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        bool success = super.transfer(to, amount);

        if (attackEnabled) {
            attackEnabled = false; // Prevent infinite loop
            attackCount++;

            // Attempt reentrancy - this call will revert with ReentrancyGuardReentrantCall
            // because we're already inside a nonReentrant function
            targetContract.withdrawFunds(ERC20(address(this)), 1e18, to);
        }

        return success;
    }
}
