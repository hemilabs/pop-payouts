// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * A mock ERC20 token that returns false on transfer instead of reverting.
 * Used to test the WithdrawFundsFailed event in PoPPayoutsV2.
 */
contract MockFailingERC20 {
    string public name = "FailingToken";
    string public symbol = "FAIL";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address receiver, uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[receiver] = initialSupply;
        emit Transfer(address(0), receiver, initialSupply);
    }

    /**
     * Always returns false to simulate a failed transfer.
     */
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
