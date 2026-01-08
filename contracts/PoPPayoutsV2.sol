// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// Contract imports
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * This contract implements the updated post-TGE PoP rewards algorithm, which is based on dynamically adjusting rewards
 * based on the actual versus expected performance of previous payout rounds.
 *
 * At a high-level, it uses the rewards paid out in recent previous rounds compared to the actual number of PoP publications
 * received to calculate an updated reward pool to pay out in future rounds in an attempt to achieve a target publication
 * redundancy of 5 for each keystone.
 *
 * Each PoP publication of a keystone receives a PoP score, which is based on how quickly the publication of the keystone to
 * Bitcoin occurred to the first publication of the same keystone to Bitcoin.
 *
 * The payout calculation algorithm determines a total reward pool for the next keystone period based on a weighted average
 * of the reward pools of past rounds versus the actual aggregate PoP scores received.
 *
 * The reward pool for each keystone period is distributed proportionally (pro-rata) amongst all participants based on their
 * PoP scores; for example if the reward pool for a particular keystone period is 100 $HEMI and 4 participants have PoP Scores
 * of [100K, 100K, 25K, 4K] respectively, then the total PoP score is 229K, and the participants with 100K will each receive
 * ~43.668 $HEMI, the participant with 25K will receive ~10.917 $HEMI, and the participant with 4K will receive ~1.747 $HEMI.
 *
 * Calculating a total reward pool and then distributing pro-rata for scored participation provides some resiliency against
 * fee market spikes compared to dynamically calculating a fixed payout-per-point, as reward pools which are only sufficient
 * to compensate PoP miners for less than the target quantity of publications will still generally incentivize a smaller number
 * of publications.
 *
 * The retargeting multiplier for future rounds is calculated using the formula: TARGET_SCORE / ACTUAL_SCORE, where
 * TARGET_SCORE is 500,000 (5 optimal publications). This creates natural resiliency for low publication counts:
 *   - 1 optimal publication (100K points): 500K/100K = 5.0x multiplier
 *   - 2 optimal publications (200K points): 500K/200K = 2.5x multiplier
 *   - 3 optimal publications (300K points): 500K/300K = 1.67x multiplier
 *   - 5 optimal publications (500K points): 500K/500K = 1.0x multiplier (target achieved)
 *   - No publications (0 points): 10x multiplier (maximum, defined by RETARGETING_MULTIPLIER_NO_SCORE)
 *
 * This is calculated based on aggregate score, not publication count; for example two publications spaced two blocks apart
 * (ex: BTC blocks 1000 and 1002) would have a score of 125K (100K for the first, 25K for the second), resulting in a
 * retargeting multiplier of 500K/125K = 4.0x.
 * 
 * The algorithm samples the most recent 1 hour of payouts with a weighted algorithm (giving much higher weight to recent rounds,
 * as they reflect more recent information about the Bitcoin fee market). This value was selected to sample recent Bitcoin fee
 * market information relative to $HEMI while smoothing over very short-term Bitcoin fee market spikes due to short-lived abnormal
 * demand or abnormally low Bitcoin mining luck.
 * 
 * It should also be noted that the payout algorithm does not need to always adequately compensate PoP miners for publications
 * to the very next possible Bitcoin block after a particular keystone is created, but must properly incentivize publications
 * within the BITCOIN_FINALITY_DELAY window of 9 BTC blocks. Faster publications are preferred as it allows faster Bitcoin
 * finality, but short delays in publications during abnormal Bitcoin fee market conditions are permissable.
 *
 * Additionally, we use indirect sampling of the Bitcoin fee market relative to $HEMI to account for all possible Bitcoin fee
 * market mechanics, including ones that are not reflected in actual Bitcoin fees paid directly to miners on-chain. Otherwise,
 * external fee markets like off-chain transaction accelerators would not be taken into account. While these external Bitcoin
 * fee market mechanics do not have significant effects on the true Bitcoin fee market at the time of implementation, it is
 * reasonable to expect they will play a greater role in the future. In particular, Hemi's hVM makes off-Bitcoin permissionless
 * BTC fee accelerators easy to build, and these fee accelerators improve Bitcoin's usability and thus are likely to eventually
 * experience significant adoption. Sampling the actual results of rewards versus publications takes into account all external
 * factors that effect the Bitcoin fee market.
 */
contract PoPPayoutsV2 is ReentrancyGuard {
    using SafeERC20 for ERC20;

    // Supply update events
    event SupplyBaseUpdated(uint256 oldSupplyBase, uint256 newSupplyBase);
    event SupplyInflationYearlyUpdated(uint256 oldSupplyInflationYearly, uint256 newSupplyInflationYearly);
    event PoPInflationAllocationUpdated(uint256 oldPopInflationAllocation, uint256 newPopInflationAllocation);
    event SupplyTimestampUpdated(uint256 oldSupplyTimestamp, uint256 newSupplyTimestamp);

    // Ownership update events
    event SupplyOwnerUpdateInit(address indexed newSupplyOwner);
    event SupplyOwnerUpdateCompleted(address indexed oldSupplyOwner, address indexed newSupplyOwner);
    event SupplyOwnerUpdateCanceled(address indexed canceledNewSupplyOwner, address indexed currentSupplyOwner);
    event OwnerUpdateInit(address indexed newOwner);
    event OwnerUpdateCompleted(address indexed oldOwner, address indexed newOwner);
    event OwnerUpdateCanceled(address indexed canceledNewOwner, address indexed currentOwner);

    // Fund withdrawals
    event WithdrawFundsSuccessful(address indexed erc20Contract, address indexed destinationAddress, uint256 amount);
    event WithdrawETHSuccessful(address indexed destinationAddress, uint256 amount);

    // Contract initialization
    event ContractInitialized(address indexed owner, address indexed supplyOwner, address indexed hemiToken);

    // Payouts
    // Note that the rewardPool will always be set even if popScore == 0; this means that the specific
    // reward pool was offered but was not paid out. This is done so that event logs carry sufficient
    // information to calculate future payout rounds.
    event PayoutRoundExecuted(uint64 indexed blockRewarded, uint256 rewardPool, uint256 popScore);

    // Emitted when rounds are backfilled due to missed keystones, providing analytics a clear signal
    // that a range of rounds were retroactively created (STATE-ADD-003 improvement)
    event RoundsBackfilled(uint64 indexed startBlock, uint64 indexed endBlock, uint256 count);

    // The onlyOwner modifier is used on all functions that should *only* be callable by the owner
    modifier onlyOwner() {
        require(msg.sender == owner, "only the owner can call this function");
        _;
    }

    // The onlySupplyOwner modifier is used on all functions that should *only* be callable by the supplyOwner.
    modifier onlySupplyOwner() {
        require(msg.sender == supplyOwner, "only the supply owner can call this function");
        _;
    }

    // The onlyDepositor modifier is used on all functions that should *only* be callable by the protocol-controlled
    // depositor account
    modifier onlyDepositor() {
        require(msg.sender == DEPOSITOR_ACCOUNT, "only the protocol-controlled depositor account can call this function");
        _;
    }

    // Mintage period of $HEMI token is every 30 days
    uint256 public constant MINTAGE_PERIOD = 30 days;

    // BPS divisor for percents expressed in BPS; i.e. 700/10,000 = 0.07 = 7%
    uint256 internal constant MAX_BPS = 100_00;

    // Account for leap-year the same way as the $HEMI token contract
    uint256 internal constant YEAR = 365.25 days;

    // 1 hour based on 5-minute keystones, approx 6 BTC blocks of fee sampling
    uint32 public constant POP_REWARD_LOOKBACK = 12;

    // The frequency of keystone blocks, 1 keystone every 25 Hemi blocks
    uint32 public constant KEYSTONE_FREQUENCY = 25;

    // One Hemi block every 12 seconds
    uint32 public constant BLOCK_TIME_SEC = 12;

    // One keystone every 25*12=300 seconds
    uint32 public constant KEYSTONE_TIME_SEC = KEYSTONE_FREQUENCY * BLOCK_TIME_SEC;

    // 288 keystones every day (86400 seconds)
    uint32 public constant KEYSTONES_PER_DAY = (1 days) / KEYSTONE_TIME_SEC;

    // The number of points for an optimal publication (published in the first two Bitcoin blocks relative to the first
    // publication of a keystone)
    uint32 public constant MAXIMUM_REWARD_POINTS_PER_PUBLICATION = 100_000;

    // The target number of optimal publications
    uint32 public constant TARGET_PUBLICATION_REDUNDANCY = 5;

    // Target aggregate publication score for each keystone.
    // With 100,000 points for an optimal publication and a target redundancy of 5, the score target is 500,000.
    uint32 public constant POP_KEYSTONE_PUBLICATION_TARGET = MAXIMUM_REWARD_POINTS_PER_PUBLICATION * TARGET_PUBLICATION_REDUNDANCY;

    // PoP rewards are not paid out for blocks that are more than 8 Bitcoin blocks (inclusive) after the first publication.
    // For example, if publications of a particular keystone occur in Bitcoin blocks 1000, 1001, 1008, and 1009, then the
    // relative publication heights of each would be 0, 1, 8, and 9 respectively, and the publication in block 1009 with
    // a relative publication height of 9 would not be rewarded because it is >= MAX_BTC_PUBLICATION_DELAY.
    uint256 public constant MAXIMUM_BTC_PUBLICATION_DELAY = 9;

    // Maximum number of publications that can be processed in a single keystone reward call.
    // This limit prevents excessive gas consumption from unbounded loops. With 75 publications,
    // worst-case gas consumption stays under 5M gas even with maximum backfill (24 skipped rounds)
    // and full lookback history. Gas analysis showed ~32K gas per additional publication.
    uint256 public constant MAXIMUM_PUBLICATIONS_PER_KEYSTONE = 75;

    // Defined by the PoPScoreDecay function 100000/((max(x,1)^2)) precomputed for efficiency, where x is the relative publication height up to a maximum
    // of MAXIMUM_BTC_PUBLICATION_DELAY Bitcoin blocks from the first publication (exclusive).
    // For example, if there are publications of a particular keystone in Bitcoin blocks 1000, 1001, 1002, 1006, and 1009 then those publications
    // would have relative publication heights of 0, 1, 2, 6, and 9 respectively. The publications in blocks 1000, 1001, 1002, and 1006 would receive
    // scores from index 0, 1, 2, and 6 respectively in this array, and the publication in block 1009 would not receive any score as it is
    // >= MAXIMUM_BTC_PUBLICATION_DELAY.
    uint256[MAXIMUM_BTC_PUBLICATION_DELAY] public PUBLICATION_HEIGHT_SCORES = [
        100000, // 100000/((max(0,1)^2)); publication in 1st relative block gets 100,000 points
        100000, // 100000/((max(1,1)^2)); publication in 2nd relative block also gets 100,000 points
        25000,  // 100000/((max(2,1)^2)); publication in 3rd relative block gets 25,000 points
        11111,  // 100000/((max(3,1)^2)); publication in 4th relative block gets 11,111 points
        6250,   // 100000/((max(4,1)^2)); publication in 5th relative block gets 6,250 points
        4000,   // 100000/((max(5,1)^2)); publication in 6th relative block gets 4,000 points
        2778,   // 100000/((max(6,1)^2)); publication in 7th relative block gets 2,778 points
        2041,   // 100000/((max(7,1)^2)); publication in 8th relative block gets 2,041 points
        1563    // 100000/((max(8,1)^2)); publication in 9th relative block gets 1,563 points
    ];


    // Defined by the PoPRewardLookbackWeighting function 1-(x/(12 + 1))^0.5 precomputed for efficiency, where x is the relative
    // recent round; index 0 is the most recently executed payout round, index 1 is the second most recently executed payout round, etc.
    // These weightings are used to weight sampling of the Bitcoin fee market based on the rewards paid out and the PoP scores actually
    // achieved in previous rounds, adjusted for the estimated reward which would have achieved the target multiplier in each round.
    // After fully saturating the 12 rounds of lookback history, each index has the following total weight:
    //    0: 20.6257% (most recent keystone round)
    //    1: 14.9042%
    //    2: 12.5364%
    //    3: 10.7172%
    //    4:  9.1847%
    //    5:  7.8337%
    //    6:  6.6126%
    //    7:  5.4906%
    //    8:  4.4449%
    //    9:  3.4631%
    //   10:  2.5349%
    //   11:  1.6521% (keystone from 1 hour ago)
    uint256[POP_REWARD_LOOKBACK] public REWARD_LOOKBACK_WEIGHTING = [
        10000, //  1-(0/(12 + 1))^0.5; 1st most recent reward round  gets 1.0000x multiplier
        7226,  //  1-(1/(12 + 1))^0.5; 2nd most recent reward round  gets 0.7226x multiplier
        6078,  //  1-(2/(12 + 1))^0.5; 3rd most recent reward round  gets 0.6078x multiplier
        5196,  //  1-(3/(12 + 1))^0.5; 4th most recent reward round  gets 0.5196x multiplier
        4453,  //  1-(4/(12 + 1))^0.5; 5th most recent reward round  gets 0.4453x multiplier
        3798,  //  1-(5/(12 + 1))^0.5; 6th most recent reward round  gets 0.3798x multiplier
        3206,  //  1-(6/(12 + 1))^0.5; 7th most recent reward round  gets 0.3206x multiplier
        2662,  //  1-(7/(12 + 1))^0.5; 8th most recent reward round  gets 0.2662x multiplier
        2155,  //  1-(8/(12 + 1))^0.5; 9th most recent reward round  gets 0.2155x multiplier
        1679,  //  1-(9/(12 + 1))^0.5; 10th most recent reward round gets 0.1679x multiplier
        1229,  // 1-(10/(12 + 1))^0.5; 11th most recent reward round gets 0.1229x multiplier
        801    // 1-(11/(12 + 1))^0.5; 12th most recent reward round gets 0.0801x multiplier
    ];

    // When a lot of rounds are skipped, computing all their historical states is too expensive and does not normally matter;
    // if more than this many rounds are missing then the past rounds needed for calculation will be set to the maximum permitted
    // emissions. This is set to 2x the length of the reward lookback period (2x12=24), which is a safe number of skipped keystones
    // where it is assumed that the missing keystones used for future reward calculation can be filled with the maximum reward
    // permitted by emissions.
    uint64 public constant MAXIMUM_SKIPPED_ROUND_RECALCULATION = 24;

    // When a round received no publications, then its retargeting multiplier is set to 10x.
    uint256 public constant RETARGETING_MULTIPLIER_NO_SCORE = 10 * MAX_BPS;

    // Address of the special depositor account who can call the mintPoPRewards() function.
    address public constant DEPOSITOR_ACCOUNT = 0x8888888888888888888888888888888888888888;

    // The maximum supplyInflationYearly which can be set, in BPS.
    uint256 public constant MAX_SUPPLY_INFLATION_YEARLY = 700;

    // The maximum popInflationAllocation which can be set, in BPS.
    uint256 public constant MAX_POP_INFLATION_ALLOCATION = 500;

    // This value is used to multiply and later divide token calculations to reduce rounding errors.
    // 1e18 doesn't cause any overflow issues unless the ERC20 atomic value is > (2^256-1)/1e18 = 
    // ~1.1579 * 10^59 atomic units, or 1.1579 * 10^41 regular units assuming 18 decimals.
    uint256 public constant ERC20_ROUNDING_ERROR_FACTOR = 1e18;

    // Maximum supply of reward ERC20 token allowed, above which the erc20SupplyCalculationMultiplicationFactor
    // causes overflows.
    uint256 public constant ERC20_MAX_SUPPLY = 1e20 * ERC20_ROUNDING_ERROR_FACTOR;

    // Minimum supply of reward ERC20 token required to ensure numerical precision in calculations.
    // Set to 1e24 (1 million tokens with 18 decimals), which is significantly below Hemi's production
    // supply of 10 billion tokens (1e28) but high enough to prevent any meaningful rounding errors
    // in reward pool and inflation calculations.
    uint256 public constant ERC20_MIN_SUPPLY = 1e24;

    // The owner address who can modify the supply owner and withdraw funds from this payout contract.
    address public owner;

    // The pending update to the owner
    address public pendingOwner;

    // The owner address who can modify supply settings.
    address public supplyOwner;

    // The pending update to the supply owner
    address public pendingSupplyOwner;

    // The contract of the $HEMI token (set once via initializeHemiToken, never modified after)
    ERC20 public hemiTokenContract;

    // The base supply on top of which inflation is calculated.
    // This can be updated by the supply owner of the contract when inflation is reduced.
    uint256 public supplyBase;

    // The yearly supply inflation, assumed to be compounded monthly.
    uint256 public supplyInflationYearly;

    // The yearly inflation allocated to PoP
    uint256 public popInflationAllocation;

    // The timestamp at which inflation on top of the supplyBase at the supplyInflationYearly rate
    // occurs, such that the first inflation mintage will occur a month after this timestamp.
    uint256 public supplyTimestamp;

    // The most recent block height in which PoP Payouts were processed
    uint64 public lastBlockRewarded = 0;

    // The total rewards (in $HEMI) which have been distributed to-date for PoP payouts.
    uint256 public totalPoPRewards = 0;

    // The initial rewards (in atomic units) to pay out in the first round.
    // Set once in initialize(), never modified after.
    uint256 public firstRoundRewards;

    // All of the previous payout rounds.
    // Note: rounds.length serves as the next round index (STATE-ADD-001 optimization)
    PayoutRound[] public rounds;

    // Optimized for precise emission calculations depending on the initial supply.
    // Note that as used (1e18 * non-atomic supply), this breaks past a non-atomic supply of ~1e20 which is considered 
    // fine for our uses where Hemi initial supply = 1e10.
    // This is set dynamically rather than being fixed to 1e18 * ERC20_MAX_SUPPLY as too-high values slightly
    // over-estimate emissions by a small number of atomic units.
    uint256 public erc20SupplyCalculationMultiplicationFactor;

    // Contains the information from an executed payout round required to compute the rewards for future rounds,
    // as well as allowing clients to query important information about previous rounds.
    // Note that if totalPoPScore == 0 (no PoP payouts, no publications) then the rewardPool will still be nonzero
    // so that the algorithm can use what *should* have been paid out along with knowing no publications occurred
    // to properly calculate future round rewards.
    struct PayoutRound {
        uint64 blockHeight;    // The height of the keystone the reward round was for (not the block it was executed in)
        uint256 totalPoPScore; // The total score of all publications of the keystone at blockHeight
        uint256 rewardPool;    // The total reward pool paid out during the round
    }

    /**
     * Empty constructor for deterministic CREATE2 addresses.
     * All configuration is done via initialize().
     */
    constructor() {
        // No-op: all initialization happens in initialize()
    }

    /**
     * Initializes the contract with all configuration parameters.
     * Can only be called once. This enables deterministic CREATE2 addresses
     * across networks regardless of configuration values.
     *
     * @param _owner The initial owner who can update the supply owner and withdraw assets
     * @param _supplyOwner The initial supply owner who can make supply adjustments
     * @param _hemiTokenContract The contract address of the $HEMI token
     * @param _initialSupply The initial total supply of the $HEMI token
     * @param _initialInflationYearly The initial annual inflation rate in BPS (ex: 700 = 7%)
     * @param _popInflationAllocation The initial amount of inflation which is allocated to PoP in BPS (ex: 500 = 5%)
     * @param _supplyTimestamp The timestamp from which supply inflation begins
     * @param _firstRoundRewards The initial rewards for the first payout round
     */
    function initialize(
        address _owner,
        address _supplyOwner,
        address _hemiTokenContract,
        uint256 _initialSupply,
        uint256 _initialInflationYearly,
        uint256 _popInflationAllocation,
        uint256 _supplyTimestamp,
        uint256 _firstRoundRewards
    ) external {
        // Check not already initialized
        require(owner == address(0), "contract already initialized");

        // Validate addresses
        require(_owner != address(0), "owner cannot be zero address");
        require(_supplyOwner != address(0), "supply owner cannot be zero address");
        require(_hemiTokenContract != address(0), "hemi token contract cannot be zero address");
        require(_hemiTokenContract.code.length > 0, "hemi token address must contain contract code");

        // Validate supply parameters
        require(_initialSupply >= ERC20_MIN_SUPPLY, "initial supply too small for numerical precision");
        require(_initialSupply <= ERC20_MAX_SUPPLY, "initial supply too large");
        require(_initialInflationYearly <= MAX_SUPPLY_INFLATION_YEARLY, "initial inflation is too high");
        require(_popInflationAllocation <= MAX_POP_INFLATION_ALLOCATION, "PoP inflation is too high");
        require(_popInflationAllocation <= _initialInflationYearly, "PoP inflation must be less than or equal to initial inflation");
        require(_supplyTimestamp < block.timestamp, "supply timestamp must be in the past");
        require(_firstRoundRewards > 0, "first round rewards cannot be zero");

        // Set ownership
        owner = _owner;
        supplyOwner = _supplyOwner;
        hemiTokenContract = ERC20(_hemiTokenContract);

        // Set supply parameters
        supplyBase = _initialSupply;
        supplyInflationYearly = _initialInflationYearly;
        popInflationAllocation = _popInflationAllocation;
        supplyTimestamp = _supplyTimestamp;
        erc20SupplyCalculationMultiplicationFactor = ERC20_ROUNDING_ERROR_FACTOR * (_initialSupply / ERC20_ROUNDING_ERROR_FACTOR);

        // Validate firstRoundRewards against maximum allowed by inflation (requires supply state to be set first)
        require(_firstRoundRewards <= calculateMaximumRewardPool(_supplyTimestamp), "first round rewards exceed maximum allowed by inflation");
        firstRoundRewards = _firstRoundRewards;

        // Emit events
        emit SupplyBaseUpdated(0, _initialSupply);
        emit SupplyInflationYearlyUpdated(0, _initialInflationYearly);
        emit PoPInflationAllocationUpdated(0, _popInflationAllocation);
        emit SupplyTimestampUpdated(0, _supplyTimestamp);
        emit OwnerUpdateCompleted(address(0), _owner);
        emit SupplyOwnerUpdateCompleted(address(0), _supplyOwner);
        emit ContractInitialized(_owner, _supplyOwner, _hemiTokenContract);
    }

    /**
     * Updates the supply information. New values must adhere to the maximum constant respective values, and the new supply base
     * and supply timestamp cannot be lower than the previous values. Only callable by the supplyOwner.
     *
     * This function allows for the yearly supply inflation to be increased compared to previous values, unlike the base $HEMI contract. 
     * This is intentional, to allow more flexibility in using lower-then-actual values for some use-cases (such as temporarily lowering
     * perceived inflation for the purposes of PoP payouts where excess inflation will be burnt but not permanently prevented from
     * future emissions).
     * 
     * Updates to these values will only effect new payout rounds paid out after the change; for example if a payout round occurs at timestamp
     * 1000, and then an update to the supply base timestamp and corresponding inflation / PoP inflation allocation is made which sets the
     * supply base timestamp to 975, only the next keystone payout at 1025 will be paid out using the updated supply information, and if
     * the payout at keystone 1000 used parameters that allowed higher PoP payouts than the new settings, then round 1000 would have executed
     * with the higher PoP payout than it should have based on parameters that are set in the future. This behavior is expected; changes to
     * supply parameters are expected to be quickly communicated to this contract.
     *
     * @param _updatedSupplyBase The new supplyBase
     * @param _updatedSupplyInflationYearly The new supplyInflationYearly
     * @param _updatedPoPInflationAllocation The new popInflationAllocation
     * @param _updatedSupplyTimestamp The new supplyTimestamp
     */
    function updateSupplyInformation(uint256 _updatedSupplyBase, uint256 _updatedSupplyInflationYearly, 
    uint256 _updatedPoPInflationAllocation, uint256 _updatedSupplyTimestamp) external onlySupplyOwner {
        require(_updatedSupplyBase >= supplyBase, "supply base can only be increased");
        require(_updatedSupplyInflationYearly <= MAX_SUPPLY_INFLATION_YEARLY, "inflation is too high");
        require(_updatedPoPInflationAllocation <= MAX_POP_INFLATION_ALLOCATION, "PoP inflation is too high");
        require(_updatedPoPInflationAllocation <= _updatedSupplyInflationYearly, "PoP inflation must be less than or equal to inflation");
        require(_updatedSupplyTimestamp >= supplyTimestamp, "updated supply timestamp must be greater than or equal to current supply timestamp");
        require(_updatedSupplyTimestamp <= block.timestamp, "updated supply timestamp cannot be in the future");
        require(_updatedSupplyBase <= ERC20_MAX_SUPPLY, "updated supply too large");

        // Not all supply update calls update all supply settings, so detect which ones are changed and only emit events for changed settings

        if (supplyBase != _updatedSupplyBase) {
            emit SupplyBaseUpdated(supplyBase, _updatedSupplyBase);
            supplyBase = _updatedSupplyBase;

            // Need to update rounding error factor for new supply base
            erc20SupplyCalculationMultiplicationFactor = ERC20_ROUNDING_ERROR_FACTOR * (supplyBase / ERC20_ROUNDING_ERROR_FACTOR);
        }

        if (supplyInflationYearly != _updatedSupplyInflationYearly) {
            emit SupplyInflationYearlyUpdated(supplyInflationYearly, _updatedSupplyInflationYearly);
            supplyInflationYearly = _updatedSupplyInflationYearly;
        }

        if (popInflationAllocation != _updatedPoPInflationAllocation) {
            emit PoPInflationAllocationUpdated(popInflationAllocation, _updatedPoPInflationAllocation);
            popInflationAllocation = _updatedPoPInflationAllocation;
        }

        if (supplyTimestamp != _updatedSupplyTimestamp) {
            emit SupplyTimestampUpdated(supplyTimestamp, _updatedSupplyTimestamp);
            supplyTimestamp = _updatedSupplyTimestamp;
        }
    }

    /**
     * Initializes an update to the supply owner, only callable by the owner.
     *
     * @param _newSupplyOwner The address of the new supply owner
     */
    function updateSupplyOwnerInit(address _newSupplyOwner) external onlyOwner {
        require(_newSupplyOwner != address(0), "new supply owner cannot be zero address");
        require(_newSupplyOwner != supplyOwner, "new supply owner cannot be existing supply owner");

        pendingSupplyOwner = _newSupplyOwner;
        emit SupplyOwnerUpdateInit(pendingSupplyOwner);
    }

    /**
     * Finalizes an update to the supply owner, only callable by the new pending supply owner.
     * Cannot be called if there is not a pendingSupplyOwner currently set.
     */
    function updateSupplyOwnerFinalize() external {
        require(pendingSupplyOwner != address(0), "can not finalize supply owner update when no pending supply owner update is in progress");
        require(msg.sender == pendingSupplyOwner, "can only be called by the pending supply owner");
    
        emit SupplyOwnerUpdateCompleted(supplyOwner, pendingSupplyOwner);
        supplyOwner = pendingSupplyOwner;
        pendingSupplyOwner = address(0);
    }

    /**
     * Cancels a pending update to the supply owner. Only callable by the new pending supply owner or the owner.
     * Cannot be called if there is not a pendingSupplyOwner currently set.
     */
    function updateSupplyOwnerCancel() external {
        require(pendingSupplyOwner != address(0), "cannot cancel a supply owner update if none is pending");
        require(msg.sender == pendingSupplyOwner || msg.sender == owner, "only owner or pending supply owner can cancel a supply owner update");

        emit SupplyOwnerUpdateCanceled(pendingSupplyOwner, supplyOwner);
        pendingSupplyOwner = address(0);
    }

    /**
     * This function allows the protocol-controlled depositor address to force a supply owner upgrade.
     *
     * @param _newSupplyOwner The new supply owner to set
     */
    function protocolForceSupplyOwnerUpdate(address _newSupplyOwner) external onlyDepositor {
        require(_newSupplyOwner != address(0), "new supply owner cannot be zero address");
        require(_newSupplyOwner != supplyOwner, "new supply owner cannot be existing supply owner");

        // Emit cancellation event if there was a pending transfer (GOV-ADD-006)
        if (pendingSupplyOwner != address(0)) {
            emit SupplyOwnerUpdateCanceled(pendingSupplyOwner, supplyOwner);
        }

        emit SupplyOwnerUpdateCompleted(supplyOwner, _newSupplyOwner);

        supplyOwner = _newSupplyOwner;
        pendingSupplyOwner = address(0);
    }

    /**
     * Initializes an update to the owner, only callable by the current owner.
     *
     * @param _newOwner The address of the new owner
     */
    function updateOwnerInit(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "new owner cannot be zero address");
        require(_newOwner != owner, "new owner cannot be existing owner");

        pendingOwner = _newOwner;
        emit OwnerUpdateInit(pendingOwner);
    }

    /**
     * Finalizes an update to the owner, only callable by the new pending owner.
     * Cannot be called if there is not a pendingOwner currently set.
     */
    function updateOwnerFinalize() external {
        require(pendingOwner != address(0), "can not finalize owner update when no pending owner update is in progress");
        require(msg.sender == pendingOwner, "can only be called by the pending owner");

        emit OwnerUpdateCompleted(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /**
     * Cancels a pending update to the owner. Only callable by the current owner or the new pending owner.
     * Cannot be called if there is not a pendingOwner currently set.
     */
    function updateOwnerCancel() external {
        require(pendingOwner != address(0), "cannot cancel an owner update if none is pending");
        require(msg.sender == owner || msg.sender == pendingOwner, "only owner or pending owner can cancel an owner update");

        emit OwnerUpdateCanceled(pendingOwner, owner);
        pendingOwner = address(0);
    }

    /**
     * This function allows the protocol-controlled depositor address to force an owner upgrade.
     *
     * @param _newOwner The new owner to set
     */
    function protocolForceOwnerUpdate(address _newOwner) external onlyDepositor {
        require(_newOwner != address(0), "new owner cannot be zero address");
        require(_newOwner != owner, "new owner cannot be existing owner");

        // Emit cancellation event if there was a pending transfer (GOV-ADD-006)
        if (pendingOwner != address(0)) {
            emit OwnerUpdateCanceled(pendingOwner, owner);
        }

        emit OwnerUpdateCompleted(owner, _newOwner);

        owner = _newOwner;
        pendingOwner = address(0);
    }

    /**
     * This function allows the protocol-controlled depositor address to force an ERC20 fund withdrawal,
     * akin to the withdrawFunds() function that the owner can call.
     * 
     * @param contractAddress The contract address of the ERC20 token contract for which funds should be withdrawn
     * @param amount The amount of tokens to withdraw to the destinationAddress
     * @param destinationAddress The destination address to send the withdrawn funds to
     */
    function protocolForceWithdrawFunds(ERC20 contractAddress, uint256 amount, address destinationAddress) external onlyDepositor {
        _withdrawFundsImpl(contractAddress, amount, destinationAddress);
    }

    /**
     * Withdraws funds for any ERC20 contract to the specified destination address.
     * Allows withdrawal of funds for any ERC20 contract to recall incorrectly sent funds from contract addresses
     * that aren't the $HEMI token contract address.
     *
     * @param contractAddress The contract address of the ERC20 token contract for which funds should be withdrawn
     * @param amount The amount of tokens to withdraw to the destinationAddress
     * @param destinationAddress The destination address to send the withdrawn funds to
     */
    function withdrawFunds(ERC20 contractAddress, uint256 amount, address destinationAddress) external onlyOwner {
        _withdrawFundsImpl(contractAddress, amount, destinationAddress);
    }

    /**
     * Implementation for withdrawing ERC20 funds owned by this contract to the specified destination.
     *
     * @param contractAddress The contract address of the ERC20 token contract for which funds should be withdrawn
     * @param amount The amount of tokens to withdraw to the destinationAddress
     * @param destinationAddress The destination address to send the withdrawn funds to
     */
    function _withdrawFundsImpl(ERC20 contractAddress, uint256 amount, address destinationAddress) private nonReentrant {
        require(address(contractAddress) != address(0), "cannot withdraw funds from a zero address token contract");
        require(destinationAddress != address(0), "cannot withdraw funds to a zero address destination");
        require(amount != 0, "cannot withdraw a zero amount of funds");

        // Use safeTransfer to handle non-standard ERC20 tokens (like USDT) that don't return a boolean.
        // safeTransfer reverts on failure, so no need for success/failure handling.
        contractAddress.safeTransfer(destinationAddress, amount);
        emit WithdrawFundsSuccessful(address(contractAddress), destinationAddress, amount);
    }

    /**
     * Rejects direct ETH transfers to this contract.
     * ETH can still be force-sent via selfdestruct, so withdrawETH functions are provided for recovery.
     */
    receive() external payable {
        revert("ETH transfers not accepted");
    }

    /**
     * Withdraws ETH from the contract to the specified destination address.
     * This is primarily for recovering ETH that was force-sent via selfdestruct.
     *
     * @param amount The amount of ETH to withdraw
     * @param destinationAddress The destination address to send the ETH to
     */
    function withdrawETH(uint256 amount, address payable destinationAddress) external onlyOwner nonReentrant {
        require(destinationAddress != address(0), "cannot withdraw ETH to zero address");
        require(amount != 0, "cannot withdraw zero ETH");
        require(address(this).balance >= amount, "insufficient ETH balance");

        (bool success, ) = destinationAddress.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit WithdrawETHSuccessful(destinationAddress, amount);
    }

    /**
     * Allows the protocol to force withdraw ETH from the contract.
     *
     * @param amount The amount of ETH to withdraw
     * @param destinationAddress The destination address to send the ETH to
     */
    function protocolForceWithdrawETH(uint256 amount, address payable destinationAddress) external onlyDepositor nonReentrant {
        require(destinationAddress != address(0), "cannot withdraw ETH to zero address");
        require(amount != 0, "cannot withdraw zero ETH");
        require(address(this).balance >= amount, "insufficient ETH balance");

        (bool success, ) = destinationAddress.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit WithdrawETHSuccessful(destinationAddress, amount);
    }

    /**
     * Calculates the timestamp of a past or current block.
     * 
     * This calculation is reliable on L2s like Hemi which have a fixed block timestamp, which is different than
     * networks like Ethereum, where a missed slot does not contribute to the block number.
     * 
     * In the future when Hemi adopts decentralized sequencing this may need to be updated, however the calculation
     * based on the current block timestamp means it would still be close to accurate for recent blocks (ex: if current
     * block = 1000, we are calculating the height for block 500, and there were 3 missed blocks between 500 and 1000, 
     * this calculation would be off by 3*12=36 seconds). For our purposes in this contract, the block timestamp is
     * only used for inflation calculation so the worst case is a small number of recent keystones could be incorrectly 
     * permitted to emit the maximum PoP rewards of the next month.
     * 
     * @param _height The block height to calculate the timestamp for
     */
    function calculateBlockTimestamp(uint64 _height) public view returns (uint64) {
        // We could calculate future timestamps but no code paths in the PoP Payouts should be calculating
        // future timestamps so this is an additional protection against unexpected behavior.
        require(_height <= block.number, "cannot calculate height for future block");

        return uint64(block.timestamp) - ((uint64(block.number) - _height) * uint64(BLOCK_TIME_SEC));
    }

    /* @notice Allows the protocol to send $HEMI tokens for PoP payouts.
     * 
     * Only callable by the DEPOSITOR_ACCOUNT which is a special account used by the sequencer to perform PoP payouts.
     * 
     * This function is called with the keystone block for which rewards are being issued, and an entry in both the _accounts
     * and the _relPubHeights array for each PoP publication of the keystone. The _relPubHeights are relative publication
     * heights in Bitcoin, so there must necessarily be at least one _relPubHeights which is 0, as long as there is at least
     * one publication by at least one address. 
     * 
     * Note that an address can have multiple entries with the same or different entries in _relPubHeights. For example, an
     * address could have two publications both in the first Bitcoin block of any other publications and would have two 
     * corresponding entries in _relPubHeights of 0, or could have one publication in the first block and another in the third,
     * and would have two corresponding entries in _relPubHeights of 0 and 2 respectively. In this case, the payouts are
     * executed individually, so that each payout can be associated with a publication.
     *
     * @param _blockRewarded The block number of the keystone for which rewards are being distributed
     * @param _accounts The accounts receiving $HEMI
     * @param _publicationHeights  The relative heights of each miner's publication
     */ 
    function mintPoPRewards(uint64 _blockRewarded, address[] calldata _accounts, uint32[] calldata _relPubHeights) external onlyDepositor nonReentrant {
        require(_accounts.length == _relPubHeights.length, "Minting PoP rewards requires the accounts and publication heights to be the same length");
        require(_accounts.length <= MAXIMUM_PUBLICATIONS_PER_KEYSTONE, "Too many publications for single keystone");
        require(_blockRewarded % KEYSTONE_FREQUENCY == 0, "PoP Payouts can only be performed for a keystone block height");
        require(_blockRewarded > lastBlockRewarded, "Cannot reward keystones out-of-order");

        // This could be made more strict by having the PoP Payout Delay configured in the contract, but not setting it allows
        // changes to the delay without throwing errors in the contract.
        require(_blockRewarded < block.number, "Cannot reward a block at/above the current height");

        // Check if lastBlockRewarded == 0, if so it's the first call, so artifically set it to _blockRewarded - KEYSTONE_FREQUENCY
        if (lastBlockRewarded == 0) {
            lastBlockRewarded = _blockRewarded - KEYSTONE_FREQUENCY;
        }

        // If the keystone being rewarded is not immediately after the last keystone rewarded, fill in the missing skipped
        // rounds before calculating the reward for this round.
        // Normally this is handled by still calling mintPoPRewards with no publications, but this will fix any instance
        // where zero-reward payouts do not trigger a call.
        uint256 numRoundsToCalculate = (_blockRewarded - lastBlockRewarded) / KEYSTONE_FREQUENCY - 1;
        if (numRoundsToCalculate > 0) {
            // We use a value MAXIMUM_SKIPPED_ROUND_RECALCULATION = 2x REWARD_LOOKBACK_WEIGHTING, since close
            // to the REWARD_LOOKBACK_WEIGHTING missing payouts in some cases could cause the correct calculation
            // to need to walk forward from the previous payout round information. With large gaps in most reasonable
            // scenarios, the payouts would quickly rise to the maximum anyway so we can avoid the expensive calculation
            // and just assume this case.
            if (numRoundsToCalculate > MAXIMUM_SKIPPED_ROUND_RECALCULATION) {
                // Special case: to extremely super gas-intensive past round calculation, if we have more than 24 skipped
                // rounds then just backfill in the last 12 rounds with maximum rewards.
                // This means that the round index will not line up with the keystone frequency multiplied by round index
                // added onto the first keystone rewarded, but this is fine as the code does not perform any calculations
                // based on this assumption.

                uint64 startingBackfillBlock = _blockRewarded - ((uint64(REWARD_LOOKBACK_WEIGHTING.length) + 1) * KEYSTONE_FREQUENCY);

                // As an optimization, only calculate the maximum reward pool once.
                // It's possible that the backfill period is over a supply increase, however
                // the calculation for the actual rewarded round will always be higher than
                // the proper maximum for its height since these rounds will all be multiplied
                // by 10x weight, so this optimization doesn't cause rewards lower than expected
                // for the next payout after a backfill period that crosses an emissions boundary.
                uint256 maxRoundReward = calculateMaximumRewardPool(calculateBlockTimestamp(startingBackfillBlock));
                uint256 backfillCount = 0;
                for (uint64 i = startingBackfillBlock; i < _blockRewarded; i+=KEYSTONE_FREQUENCY) {
                    rounds.push(PayoutRound({
                        blockHeight: i,
                        totalPoPScore: 0,
                        rewardPool: maxRoundReward
                    }));

                    // Emit event for the backfilled round (consistent with regular backfill path)
                    emit PayoutRoundExecuted(i, maxRoundReward, 0);
                    backfillCount++;
                }

                lastBlockRewarded = _blockRewarded - KEYSTONE_FREQUENCY;

                // Emit summary event for analytics (STATE-ADD-003 improvement)
                emit RoundsBackfilled(startingBackfillBlock, lastBlockRewarded, backfillCount);
            } else {
                uint64 backfillStartBlock = lastBlockRewarded + KEYSTONE_FREQUENCY;
                for (uint64 i = 0; i < numRoundsToCalculate; i++) {
                    // Calculate the block height for this backfilled round
                    uint64 backfilledBlock = lastBlockRewarded + KEYSTONE_FREQUENCY;

                    // Use the timestamp of the block being backfilled (not the previous block)
                    uint256 retroRewardPool = calculateNextRewardPool(calculateBlockTimestamp(backfilledBlock));
                    rounds.push(PayoutRound({
                        blockHeight: backfilledBlock,
                        totalPoPScore: 0,
                        rewardPool: retroRewardPool
                    }));

                    lastBlockRewarded += KEYSTONE_FREQUENCY;

                    // Still emit an event for the skipped round
                    emit PayoutRoundExecuted(lastBlockRewarded, retroRewardPool, 0);
                }

                // Emit summary event for analytics (STATE-ADD-003 improvement)
                emit RoundsBackfilled(backfillStartBlock, lastBlockRewarded, numRoundsToCalculate);
            }
        }

        // Calculate the reward pool based on recent previous keystone rounds' PoP scores
        uint256 rewardPool = calculateNextRewardPool(calculateBlockTimestamp(_blockRewarded));

        if (_accounts.length == 0) {
            rounds.push(PayoutRound({
                blockHeight: _blockRewarded,
                totalPoPScore: 0,
                rewardPool: rewardPool
            }));

            lastBlockRewarded = _blockRewarded;
            emit PayoutRoundExecuted(lastBlockRewarded, rewardPool, 0);

            return;
        }

        // Loop through all of the relative publication heights and calculate the total PoP publication score
        uint256 totalPoints = 0;
        bool foundLowest = false;
        for (uint256 i = 0; i < _relPubHeights.length; i++) {
            if (_relPubHeights[i] < MAXIMUM_BTC_PUBLICATION_DELAY) {
                totalPoints += PUBLICATION_HEIGHT_SCORES[_relPubHeights[i]];
            }
            if (_relPubHeights[i] == 0) {
                foundLowest = true;
            }
        }

        // All publication heights are relative, so it is not possible for there not to be a single publication
        // with a relative height of 0; by definition if there is at least one publication, then at least one
        // of those publications came with/before the others.
        require(foundLowest, "at least one of the publications must be at earliest relative height 0");

        // Calculate the rewards to distribute per point.
        // Note that integer division can cause total rewards to be slightly lower than the reward pool.
        // We use ERC20_ROUNDING_ERROR_FACTOR to minimize this rounding, which will be divided out
        // during reward distribution.
        uint256 rewardsPerPointMultAdjusted = rewardPool * ERC20_ROUNDING_ERROR_FACTOR / totalPoints;

        // Calculate the actual rewards distributed, which could be slightly lower due to integer division
        uint256 rewardsPaid = 0;

        // Distribute the rewards.
        for (uint256 i = 0; i < _relPubHeights.length; i++) {
            // Skip zero addresses gracefully to prevent griefing attacks where a zero-address
            // publication could cause the entire round to revert, harming other recipients.
            // The skipped reward remains in the contract.
            if (_relPubHeights[i] < MAXIMUM_BTC_PUBLICATION_DELAY && _accounts[i] != address(0)) {
                uint256 points = PUBLICATION_HEIGHT_SCORES[_relPubHeights[i]];

                // Divide out the rounding error multiplier
                uint256 earnedReward = rewardsPerPointMultAdjusted * points / ERC20_ROUNDING_ERROR_FACTOR;

                hemiTokenContract.safeTransfer(_accounts[i], earnedReward);
                rewardsPaid += earnedReward;
            }
        }

        // Should be impossible; this indicates a divergence in behavior between the loop to calculate
        // total points and the loop for reward distribution.
        // <= instead of = because integer rounding can cause total rewards paid to be slightly lower
        // than total permitted reward pool.
        require(rewardsPaid <= rewardPool, "rewards paid cannot be greater than total reward pool");

        rounds.push(PayoutRound({
            blockHeight: _blockRewarded,
            totalPoPScore: totalPoints,
            rewardPool: rewardPool
        }));

        lastBlockRewarded = _blockRewarded;

        // Add rewardsPaid instead of rewardPool since rewardsPaid can be slightly smaller due to rounding
        totalPoPRewards += rewardsPaid; 

        // Event should still emit the reward pool rather than rewardsPaid since that is what future calculations
        // that users looking at events to calculate should use.
        emit PayoutRoundExecuted(_blockRewarded, rewardPool, totalPoints);
    }

    /**
     * Calculates the reward pool for the next round.
     *
     * This calculation is based on the 12 previous rounds (last hour of keystones), by predicting what payouts would
     * have actually achieved the target PoP publication score by comparing the actual amount paid out and the actual
     * PoP score received. This allows the protocol to sample the effective Bitcoin fee market dynamics versus $HEMI
     * payouts. The predicted historical payments are weighted, such that the most recent samples which should reflect
     * more up-to-date Bitcoin fee market information have a higher effect on the reward calculation for the current
     * round, but that older data which may indicate longer-term Bitcoin fee market trends is still considered.
     *
     * The weighting algorithm used is 1-(x/(PoPRewardLookback + 1))^0.5 where x is the index of the payout round,
     * starting from 0 which is the most recent executed payout round, giving the rounds the following weights:
     *    Round 0   (5 min ago): 1.0000x
     *    Round 1  (10 min ago): 0.7226x
     *    Round 2  (15 min ago): 0.6078x
     *    Round 3  (20 min ago): 0.5196x
     *    Round 4  (25 min ago): 0.4453x
     *    Round 5  (30 min ago): 0.3798x
     *    Round 6  (35 min ago): 0.3206x
     *    Round 7  (40 min ago): 0.2662x
     *    Round 8  (45 min ago): 0.2155x
     *    Round 9  (50 min ago): 0.1679x
     *    Round 10 (55 min ago): 0.1229x
     *    Round 11 (60 min ago): 0.0801x
     * 
     * Algorithm:
     *   - For each of the last POP_REWARD_LOOKBACK rounds: 
     *       - Calculate the retargeting multiplier by dividing the POP_KEYSTONE_PUBLICATION_TARGET by the actual PoP score.
     *         In special case where the PoP score was 0, set the multiplier to 10x. This is how much the payout in that
     *         round would have to have been adjusted (upwards or downwards) by to achieve the actual target PoP score.
     *       - For each of the last POP_REWARD_LOOKBACK rounds, calculate the target-adjusted reward pool by multiplying
     *         the retargeting multiplier calculated above by the reward pool. This is the actual reward for that round
     *         that the protocol estimates would have achieved the target PoP score.
     *       - Multiply the target-adjusted reward pool calculated above by the PoP reward lookback weighting, and add it
     *         to a running sum of the weighted target-adjusted reward pool. This is the weighted contribution of the
     *         Bitcoin fee market sampling from this round used to estimate the ideal payout for the current round.
     *   - Divide the sum of the weighted target-adjusted reward pool by the sum of the PoP reward lookback weights to
     *     get the actual reward pool.
     * 
     * @param _time The timestamp to calculate the reward pool for
     */
    function calculateNextRewardPool(uint256 _time) public view returns (uint256) {
        // Special case for the first round, return configured value
        if (rounds.length == 0) {
            return firstRoundRewards;
        }

        uint256 weightedTargetAdjustedRewardPoolSum = 0;

        // We do not pre-calculate the weighting sum so that our calculations are correct in early rounds where there
        // is not enough history.
        uint256 weightingSum = 0;

        // Loop through the last POP_REWARD_LOOKBACK (12) payout rounds and calculate their contribution towards the
        // current reward pool.
        for (uint64 lookback = 0; lookback < POP_REWARD_LOOKBACK; lookback++) {
            // Calculate the index of the round to look up in the array of previous PayoutRounds
            int64 roundLookupIndex = int64(uint64(rounds.length)) - int64(1) - int64(lookback);

            // Special case for initial PoP rewards where there is not enough history
            if (roundLookupIndex < 0) {
                break;
            }

            PayoutRound memory round = rounds[uint256(uint64(roundLookupIndex))];

            // Set to the maximum retargeting multiplier which is used for rounds in which no publications occurred (10x).
            // The multiplier indicates an estimate for how much the reward pool of the round in question would have needed to 
            // be increased or decreased by to incentivize exactly the publication target of 500_000 (5 optimal publications).
            uint256 retargetingMultiplier = RETARGETING_MULTIPLIER_NO_SCORE;

            // Should never be possible for a round to receive a score >0 and <100,000 since for a round to
            // have a non-zero score it would need to have at least one publication, and the first publication
            // would by definition be the best and receive a score of PUBLICATION_HEIGHT_SCORES[0] = 100,000.
            require(round.totalPoPScore == 0 || round.totalPoPScore >= PUBLICATION_HEIGHT_SCORES[0], 
              "publication score must be either zero or >= single optimal publication score");

            // If the totalPoPScore is not zero then calculate the correct retargeting multiplier
            if (round.totalPoPScore > 0) {
                // Retargeting multiplier is the ratio of the publication target and the actual score.
                // Examples: 
                //    Round receives 100,000 points (min possible), target is 500,000, multiplier is 5x
                //    Round receives 250,000 points, target is 500,000, multiplier is 2x
                //    Round receives 500,000 points, target is 500,000, multiplier is 1x
                //    Round receives 1,000,000 points, target is 500,000, multiplier is 0.5x
                retargetingMultiplier = (POP_KEYSTONE_PUBLICATION_TARGET * MAX_BPS) / round.totalPoPScore;
            }

            // This adjusted reward pool is the estimated reward pool for the round in question which would have incentivized
            // exactly the publication target PoP score.
            // Examples:
            //   Round paid out 200 $HEMI and received 100,000 points so multiplier is 5x and protocol estimates that 200*5=1000
            //     $HEMI tokens would have incentivized 500,000 points (5x the rewards, 5x the publications).
            //   Round paid out 50 $HEMI and received 500,000 points so multiplier is 1x and protocol "estimates" that 50*1=50
            //     $HEMI tokens would have incentivized 500,000 points, since it actually did.
            //   Round paid out 750 $HEMI and received 1,000,000 points so multiplier is 0.5x and protocol estimates that 750*0.5=375
            //     $HEMI tokens would have incentivized 500,000 points (half the rewards, half the publications).
            uint256 targetAdjustedRewardPool = round.rewardPool * retargetingMultiplier / MAX_BPS;

            // This weighted adjusted reward pool is the actual estimated ideal reward pool multiplied by the weighting multiplier.
            // Examples:
            //   The most recent round's adjusted reward pool is 150 $HEMI and gets a 1.000x weighting, so 150*1.000=150 $HEMI 
            //     is added to the weighted adjusted reward pool sum.
            //   The 2nd most recent round's adjusted reward pool is 200 $HEMI and gets a 0.7226x weighting, so 200*0.7226=144.52 $HEMI
            //     is added to the weighted adjusted reward pool sum.
            // The effect of the weightings will be divided out of the final sum by dividing by the sum of the weights.
            weightedTargetAdjustedRewardPoolSum += targetAdjustedRewardPool * REWARD_LOOKBACK_WEIGHTING[lookback];
            weightingSum += REWARD_LOOKBACK_WEIGHTING[lookback];
        }

        // Divide out the sum of the weights to get the weighted reward pool calculation
        uint256 nextRewardPool = weightedTargetAdjustedRewardPoolSum / weightingSum;

        // Calculate the maximum PoP reward pool allowed by inflation based on current supply and the PoP payouts allocation of that
        // inflation to ensure we are not exceeding it.
        uint256 maximumRewardPool = calculateMaximumRewardPool(_time);
        if (nextRewardPool > maximumRewardPool) {
            nextRewardPool = maximumRewardPool;
        }

        return nextRewardPool;
    }

    /**
     * Calculates the maximum reward pool based on the initial circulating supply plus inflation to-date.
     *
     * Every 25 blocks (25 * 12 = 300 seconds) Hemi has a keystone, which is 288 keystones per day (86400 seconds)
     * or (288 * 365.25) = 105,192 keystones per year. Actual emissions occur (and therefore compound) every 30 days, 
     * so we use the 30-day inflation quantity divided by (288 * 30) = 8,640 keystones per month.
     *
     * The maximum reward pool for a keystone is the PoP portion of the total inflation emitted during the last
     * month. For example with 7% total inflation and 5% PoP allocation and a starting supply of 10B, the first
     * month would be allowed to emit (10,000,000,000.0000 * 500 * 86400 * 30)/(365.25 * 86400 * 10000) = 
     * 41,067,761.8070 tokens to PoP miners in the first month, and the total monthly emissions of 
     * (10,000,000,000.0000 * 700 * 86400 * 30)/(365.25 * 86400 * 10000) = 57,494,866.5297 would be added to
     * the 10B supply for a total of (10,057,494,866.5297 * 500 * 86400 * 30)/(365.25 * 86400 * 10000) =
     * 41,303,880.3554 tokens to PoP miners in the second month.
     *
     * Note that PoP rewards are "floated" for the month; emissions start after 30 days and emit the tokens
     * which were allocated for the last 30 days to protocol rewards.
     * 
     * Algorithm:
     *   - Calculate the current circulating supply
     *   - Calculate the popInflationAllocation portion of the next circulating supply inflation mintage
     *   - Divide the PoP emissions which will occur during the next-month mintage by the 30-day keystone quantity
     * 
     * @param _time The timestamp to calculate the maximum reward pool at
     */
    function calculateMaximumRewardPool(uint256 _time) public view returns (uint256) {
        uint256 currentSupply = calculateCirculatingSupply(_time);

        // Don't need to calculate the total emissions, just the PoP portion.
        uint256 nextMonthPoPEmissions = ((currentSupply * popInflationAllocation * MINTAGE_PERIOD) / (YEAR * MAX_BPS));

        // monthly emissions / keystones per month
        return nextMonthPoPEmissions / (MINTAGE_PERIOD / BLOCK_TIME_SEC / KEYSTONE_FREQUENCY);
    }

    function getPeriodMultiplier() internal view returns (uint256) {
        uint256 rPeriod = (supplyInflationYearly * MINTAGE_PERIOD * erc20SupplyCalculationMultiplicationFactor)
            / (YEAR * MAX_BPS);

        // factor = 1 + r_period
        return erc20SupplyCalculationMultiplicationFactor + rPeriod;
    }

    /**
     * Fast pow calculation based on exponentiation by squaring.
     * @param num The number to raise to the exponent power
     * @param exponent The exponent to raise num to
     * @param scale The scale (ex: 1e18) of the calculation
     */
    function fastPow(uint256 num, uint256 exponent, uint256 scale) internal pure returns (uint256 result) {
        require(scale > 0, "scale cannot be zero");

        // num^0 = 1
        if (exponent == 0) {
            return scale;
        }

        // result starts at 1.0 (scaled), base starts at the number, exponent begins at the exponent.
        result = scale;
        uint256 base = num;
        uint256 exp = exponent;

        while (exp != 0) {
            // If the current bit of the exponent is set, multiply result by base.
            if ((exp & 1) != 0) {
                result = (result * base) / scale;
            }

            // Shift exponent right by 1 bit (divide by 2, floor).
            exp >>= 1;

            // Square the base for the next bit, unless we're done.
            if (exp != 0) {
                base = (base * base) / scale;
            }
        }
    }

    /**
     * Calculates the current circulating supply, based on the configured supply parameters and the time elapsed
     * since the original supply timestamp.
     *
     * Note that mintage of the $HEMI token on Ethereum must be triggered by an EOA *after* the allowed 30-day
     * mintage period. The new mintage increase on the Ethereum contract does take into account the actual time
     * between mintages, but due to compounding will not align perfectly with the circulating supply calculated
     * here. 
     *
     * For example with a base of 10B tokens and 7% inflation, the optimal first three months of mintage (mintage 
     * always executed at exactly 30 day intervals, and what this function will calculate):
     *   Day 30.0: 
     *     Inflation: (10,000,000,000.0000 * 700 * 86400 * 30)/(365.25 * 86400 * 10000) = 57,494,866.5297
     *     Total Supply: 10,057,494,866.5297
     *   Day 60.0:
     *     Inflation: (10,057,494,866.5297 * 700 * 86400 * 30)/(365.25 * 86400 * 10000) = 57,825,432.4975
     *     Total Supply: 10,115,320,299.0272
     *   Day 90.0:
     *     Inflation: (10,115,320,299.0272 * 700 * 86400 * 30)/(365.25 * 86400 * 10000) = 58,157,899.0498
     *     Total Supply: 10,173,478,198.077
     *
     * But with the same parameters if inflation was calculated at exactly 45 day intervals:
     *   Day 45.0:
     *     Inflation: (10,000,000,000.0000 * 700 * 86400 * 45)/(365.25 * 86400 * 10000) = 86,242,299.7947
     *     Total Supply: 10,086,242,299.7947
     *   Day 90.0:
     *     Inflation: (10,086,242,299.7947 * 700 * 86400 * 45)/(365.25 * 86400 * 10000) = 86,986,073.2220
     *     Total Supply: 10,173,228,373.0167
     *
     * For a difference of 249,825.0603 $HEMI between the two mintage schedules (30 and 45 day).
     *
     * In practice with mintages (which can be triggered by anyone permissionlessly) close to the 30-day schedule,
     * this drift will be minimal and non-consequential. In the event that actual versus optimal inflation
     * diverges to any significant degree, the supply admin or the protocol can set updated supply values which
     * re-align the calculations with the actual emissions schedule.
     * 
     * @param _time The timestamp to calculate the circulating supply at
     */
    function calculateCirculatingSupply(uint256 _time) public view returns (uint256) {
        require(_time >= supplyTimestamp, "time cannot be below the supply timestamp");
        require(_time <= block.timestamp, "time cannot be in the future");
        uint256 elapsed = _time - supplyTimestamp;

        if (elapsed < MINTAGE_PERIOD) {
            // No additional emissions yet; before first mintage
            return supplyBase;
        }

        // If the mintage period has elapsed, then calculate the number of mintage periods elapsed
        uint256 mintagePeriods = elapsed / MINTAGE_PERIOD;

        uint256 factor = getPeriodMultiplier();

        uint256 factorPow = fastPow(factor, mintagePeriods, erc20SupplyCalculationMultiplicationFactor);

        // supply_new = base * factor^n
        return (supplyBase * factorPow) / erc20SupplyCalculationMultiplicationFactor;
    }

    /**
     * Returns the number of completed payout rounds.
     * This replaces the removed nextRoundIndex state variable (STATE-ADD-001 optimization).
     *
     * @return The count of rounds in the rounds array
     */
    function getRoundsCount() public view returns (uint256) {
        return rounds.length;
    }
}
