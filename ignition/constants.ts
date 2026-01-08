/**
 * Shared constants for PoPPayoutsV2 deployment
 */

import { keccak256, toUtf8Bytes } from "ethers";

// CREATE2 salt identifier - change this to deploy to a different address
export const DEPLOYMENT_SALT_STRING = "PoPPayoutsV2_v1.0.0-beta";

// Convert string salt to bytes32 for CREATE2
export const DEPLOYMENT_SALT = keccak256(toUtf8Bytes(DEPLOYMENT_SALT_STRING));

// Default deployment parameters (all token amounts in wei - 18 decimals)
export const DEFAULT_DEPLOYMENT_PARAMS = {
  // Initial circulating supply: 10 billion HEMI (in wei)
  initialSupply: 10_000_000_000_000_000_000_000_000_000n,

  // Yearly inflation rate in basis points (700 = 7%)
  initialInflationYearly: 700n,

  // PoP allocation from inflation in basis points (500 = 5%)
  popInflationAllocation: 500n,

  // First round rewards: 100 HEMI (in wei)
  firstRoundRewards: 100_000_000_000_000_000_000n,
};
