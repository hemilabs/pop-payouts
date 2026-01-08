// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * Test contract for iteratively calculating supply similar to the methodology in the base Hemi contract.
 * 
 * Used to compare optimized circulating supply calculation in PoPPayoutsV2.
 */
contract RefSupplyCalculator {
    uint256 public constant MINTAGE_PERIOD = 30 days;
    uint256 internal constant MAX_BPS = 100_00;
    uint256 internal constant YEAR = 365.25 days;

    uint256 public supplyTimestamp;
    uint256 public supplyBase;
    uint256 public supplyInflationYearly;


    constructor(uint256 _supplyTimestamp, uint256 _supplyBase, uint256 _supplyInflationYearly) {
        supplyTimestamp = _supplyTimestamp;
        supplyBase = _supplyBase;
        supplyInflationYearly = _supplyInflationYearly;
    }


    /**
     * Exact calculation modeled after the inflation calculation in the base $HEMI contract on Ethereum.
     * 
     * Not used in the actual PoPPayoutsV2 due to gas efficiency, but provided here for tests that compare
     * the efficient estimation versus the exact underlying estimation. In practice, the emissions will not
     * be triggered *exactly* every 30 days, and therefore the exact versus estimated supply error is 
     * generally negligible compared to real-world delays in triggering emissions in the Ethereum-native
     * $HEMI contract.
     */
    function calculateCirculatingSupplyExact(uint256 _time) public view returns (uint256) {
        // console.log("time %o, supplyTimestamp %o", _time, supplyTimestamp);
        require(_time >= supplyTimestamp, "time cannot be below the supply timestamp");
        require(_time <= block.timestamp, "time cannot be in the future");
        uint256 elapsed = _time - supplyTimestamp;
        if (elapsed < MINTAGE_PERIOD) {
            // No mintage yet
            return supplyBase;
        }

        // If the mintage period has elapsed, then calculate the number of mintage periods elapsed
        uint256 mintagePeriods = elapsed / MINTAGE_PERIOD;

        // console.log("Elapsed=%o, MINTAGE_PERIOD=%o, mintagePeriods=%o", elapsed, MINTAGE_PERIOD, mintagePeriods);

        uint256 supply = supplyBase;

        // Calculate the total compounding inflation
        for (uint256 month = 0; month < mintagePeriods; month++) {
            supply = supply + ((supply * supplyInflationYearly * MINTAGE_PERIOD) / (YEAR * MAX_BPS));
        }

        return supply;
    }
}
