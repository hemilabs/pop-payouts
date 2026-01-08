/**
 * Compute the deterministic deployment addresses for PoPPayoutsV2
 *
 * This script calculates what addresses the contracts will be deployed to
 * using CREATE2, allowing verification before deployment.
 *
 * Usage: npx hardhat run scripts/compute-address.ts
 */

import { ethers } from "hardhat";
import { DEPLOYMENT_SALT, DEPLOYMENT_SALT_STRING, DEFAULT_DEPLOYMENT_PARAMS } from "../ignition/constants";

// Arachnid's deterministic deployment proxy (used by scripts/deploy.ts)
const ARACHNID_CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

async function main() {
  console.log("=== PoPPayoutsV2 Deterministic Address Calculator ===\n");

  console.log("Configuration:");
  console.log(`  Salt string: ${DEPLOYMENT_SALT_STRING}`);
  console.log(`  Salt (bytes32): ${DEPLOYMENT_SALT}`);
  console.log();

  // Get the contract factories to access bytecode
  const FactoryContract = await ethers.getContractFactory("PoPPayoutsV2Factory");
  const PoPPayoutsV2Contract = await ethers.getContractFactory("PoPPayoutsV2");

  console.log("Default deployment parameters:");
  console.log(`  Initial Supply: ${ethers.formatUnits(DEFAULT_DEPLOYMENT_PARAMS.initialSupply, 18)} HEMI`);
  console.log(`  Yearly Inflation: ${DEFAULT_DEPLOYMENT_PARAMS.initialInflationYearly} BPS (${Number(DEFAULT_DEPLOYMENT_PARAMS.initialInflationYearly) / 100}%)`);
  console.log(`  PoP Allocation: ${DEFAULT_DEPLOYMENT_PARAMS.popInflationAllocation} BPS (${Number(DEFAULT_DEPLOYMENT_PARAMS.popInflationAllocation) / 100}%)`);
  console.log(`  First Round Rewards: ${ethers.formatUnits(DEFAULT_DEPLOYMENT_PARAMS.firstRoundRewards, 18)} HEMI`);
  console.log();

  // === Method 1: scripts/deploy.ts (Arachnid's deployer) ===
  console.log("=== Method 1: scripts/deploy.ts (Arachnid's deployer) ===");
  console.log(`CREATE2 Deployer: ${ARACHNID_CREATE2_DEPLOYER}`);
  console.log();

  // Step 1: Compute Factory address
  const factoryBytecode = FactoryContract.bytecode;
  const factoryInitCodeHash = ethers.keccak256(factoryBytecode);
  const factoryAddress = ethers.getCreate2Address(
    ARACHNID_CREATE2_DEPLOYER,
    DEPLOYMENT_SALT,
    factoryInitCodeHash
  );
  console.log(`PoPPayoutsV2Factory will be deployed at: ${factoryAddress}`);

  // Step 2: Compute PoPPayoutsV2 address (deployed by the factory)
  // The factory uses CREATE2 with no constructor args
  const popBytecode = PoPPayoutsV2Contract.bytecode;
  const popInitCodeHash = ethers.keccak256(popBytecode);
  const popAddress = ethers.getCreate2Address(
    factoryAddress,
    DEPLOYMENT_SALT,
    popInitCodeHash
  );
  console.log(`PoPPayoutsV2 will be deployed at: ${popAddress}`);
  console.log();

  // === Method 2: Hardhat Ignition (CreateX factory) ===
  console.log("=== Method 2: Hardhat Ignition (CreateX factory) ===");
  console.log("Hardhat Ignition uses the CreateX factory for CREATE2 deployments.");
  console.log("The addresses will differ from Method 1 because CreateX is a different deployer.");
  console.log("Run the Ignition deployment to see the actual addresses.");
  console.log();

  // Summary
  console.log("=== Summary ===");
  console.log("PoPPayoutsV2 uses an initialize() pattern with no constructor arguments.");
  console.log("The deployed address depends only on:");
  console.log("  1. The CREATE2 deployer address");
  console.log("  2. The salt");
  console.log("  3. The contract bytecode (no constructor args)");
  console.log();
  console.log("IMPORTANT: Choose one deployment method and use it consistently");
  console.log("across all networks to ensure the same addresses.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
