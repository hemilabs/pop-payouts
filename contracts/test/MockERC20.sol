// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(address receiver, uint256 initialSupply) ERC20("RandomToken", "RTK") {
        _mint(receiver, initialSupply);
    }
}