// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Permit, Nonces} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

interface IL2Tunnel {
    function bridgeERC20To(
        address _localToken,
        address _remoteToken,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external;
}

/**
 * The actual Hemi contract is not required for any tests (and in fact, PoPPayoutsV2 will use an OptimismMintableERC20 
 * version of the Hemi token instead), but the actual Hemi contract deployed on Ethereum is included to provide context
 * on the contract's behavior, particularly for supply/emissions calculations.
 */
contract Hemi is ERC20, ERC20Permit, ERC20Votes, Ownable2Step {
    uint256 public constant MINTAGE_PERIOD = 30 days;
    uint32 internal constant l2TunnelMinGasLimit = 400000;
    uint256 internal constant MAX_BPS = 100_00;
    uint256 internal constant YEAR = 365.25 days;

    uint256 public lastEmission;
    uint256 public annualInflationRate;
    bool public allowInflationCut = true;

    // ### Tunnel config
    address public l2Tunnel;
    address public l2Destination;
    address public remoteToken;

    // ####### Events #######
    event EmissionsEnabled(uint256 timestamp);
    event EmissionsSetup(address indexed l2Tunnel, address indexed l2Destination, address indexed remoteToken);
    event EmissionsMinted(uint256 emissionAmount, uint256 timestamp);
    event InflationRateReduced(uint256 oldInflationRate, uint256 newAnnualInflationRate);

    error EmissionsAlreadyEnabled();
    error EmissionsNotEnabled();
    error EmissionNotSetup();
    error NullAddress();
    error EmissionAmountZero();
    error MintagePeriodNotElapsed();
    error InflationCutNotAllowed();
    error InvalidInflationRate();

    constructor(address _owner, address _initialMintReceiver, uint256 _annualInflationRate)
        ERC20("Hemi", "HEMI")
        ERC20Permit("Hemi")
        Ownable(_owner)
    {
        if (_owner == address(0) || _initialMintReceiver == address(0)) {
            revert NullAddress();
        }
        if (_annualInflationRate == 0 || _annualInflationRate > MAX_BPS) {
            revert InvalidInflationRate();
        }
        annualInflationRate = _annualInflationRate;
        // Mint initial supply to the owner
        _mint(_initialMintReceiver, 10e9 * 10 ** decimals()); // 10B tokens
    }

    /**
     * @notice Calculates the emission amount based on the time elapsed since the last emission.
     * @return _emissionAmount The calculated emission amount.
     */
    function calculateEmission() public view returns (uint256 _emissionAmount) {
        if (lastEmission == 0) {
            return 0;
        }
        uint256 _timeElapsed = block.timestamp - lastEmission;
        _emissionAmount = (totalSupply() * annualInflationRate * _timeElapsed) / (YEAR * MAX_BPS);
    }

    /**
     * @notice Mints emissions based on the calculated emission amount.
     */
    function mintEmissions() external {
        uint256 _lastEmission = lastEmission;
        if (_lastEmission == 0) {
            revert EmissionsNotEnabled();
        }
        uint256 _timeElapsed = block.timestamp - _lastEmission;
        if (_timeElapsed < MINTAGE_PERIOD) {
            revert MintagePeriodNotElapsed();
        }

        uint256 _emissionAmount = calculateEmission();
        if (_emissionAmount == 0) {
            revert EmissionAmountZero();
        }
        _mintEmission(_emissionAmount);
        lastEmission = block.timestamp;
    }

    function nonces(address owner) public view virtual override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function _mintEmission(uint256 emissionAmount_) internal {
        _mint(address(this), emissionAmount_);
        address _l2Tunnel = l2Tunnel;
        _approve(address(this), _l2Tunnel, emissionAmount_);
        IL2Tunnel(_l2Tunnel).bridgeERC20To(
            address(this), remoteToken, l2Destination, emissionAmount_, l2TunnelMinGasLimit, ""
        );
        _approve(address(this), _l2Tunnel, 0);

        emit EmissionsMinted(emissionAmount_, block.timestamp);
    }

    // ####### Owner only functions #####

    /**
     * @notice Enables emissions by setting the `lastEmission` timestamp.
     */
    function enableEmissions(uint256 firstEmissionAmount_) external onlyOwner {
        if (lastEmission != 0) {
            revert EmissionsAlreadyEnabled();
        }
        if (l2Tunnel == address(0)) {
            revert EmissionNotSetup();
        }
        if (firstEmissionAmount_ != 0) {
            _mintEmission(firstEmissionAmount_);
        }
        lastEmission = block.timestamp;
        emit EmissionsEnabled(block.timestamp);
    }

    function updateInflationRate(uint256 newInflationRate_) external onlyOwner {
        if (!allowInflationCut) {
            revert InflationCutNotAllowed();
        }

        uint256 _currentInflationRate = annualInflationRate;
        if (newInflationRate_ >= _currentInflationRate) {
            revert InvalidInflationRate();
        }

        emit InflationRateReduced(_currentInflationRate, newInflationRate_);
        annualInflationRate = newInflationRate_;
    }

    /**
     * @notice Permanently disables the ability to cut inflation rate.
     */
    function disableInflationCut() external onlyOwner {
        allowInflationCut = false;
    }

    /**
     * @notice Sets up the emissions by specifying the L2 tunnel and destination addresses.
     * owner can update multiple times as long as emission not enabled
     * @param l2Tunnel_ The address of the L2 tunnel.
     * @param l2Destination_ The address of the L2 destination.
     * @param remoteToken_ The address of the remote token.
     */
    function setupEmissions(address l2Tunnel_, address l2Destination_, address remoteToken_) external onlyOwner {
        if (lastEmission != 0) {
            revert EmissionsAlreadyEnabled();
        }
        if (l2Tunnel_ == address(0) || l2Destination_ == address(0) || remoteToken_ == address(0)) {
            revert NullAddress();
        }

        l2Tunnel = l2Tunnel_;
        l2Destination = l2Destination_;
        remoteToken = remoteToken_;

        emit EmissionsSetup(l2Tunnel_, l2Destination_, remoteToken_);
    }

    function _update(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }
}