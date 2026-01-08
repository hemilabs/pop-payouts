/**
 * Deterministic deployment script using the standard CREATE2 deployer
 * (Arachnid's deterministic-deployment-proxy at 0x4e59b44847b379578588920cA78FbF26c0B4956C)
 *
 * This ensures the same addresses on all EVM networks where this deployer exists.
 */

import hre from "hardhat";
import { keccak256, toUtf8Bytes, concat, getBytes, zeroPadValue, AbiCoder } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { DEPLOYMENT_SALT_STRING, DEPLOYMENT_SALT } from "../ignition/constants";

// Standard CREATE2 deployer (exists on most EVM chains)
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// Use shared salt from ignition/constants.ts for consistency
const SALT = DEPLOYMENT_SALT;

// Default deployment parameters
const DEFAULT_PARAMS = {
  initialSupply: 10_000_000_000_000_000_000_000_000_000n, // 10 billion HEMI
  initialInflationYearly: 700n, // 7%
  popInflationAllocation: 500n, // 5%
  firstRoundRewards: 100_000_000_000_000_000_000n, // 100 HEMI
};

async function computeCreate2Address(
  deployerAddress: string,
  salt: string,
  bytecode: string
): Promise<string> {
  const hash = keccak256(
    concat([
      "0xff",
      deployerAddress,
      salt,
      keccak256(bytecode),
    ])
  );
  return "0x" + hash.slice(-40);
}

async function deployWithCreate2(
  salt: string,
  bytecode: string
): Promise<string> {
  const [signer] = await hre.ethers.getSigners();
  
  // The CREATE2 deployer expects: salt (32 bytes) + bytecode
  const deployData = concat([salt, bytecode]);
  
  const tx = await signer.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: deployData,
  });
  
  console.log(`  Transaction hash: ${tx.hash}`);
  const receipt = await tx.wait();
  
  if (!receipt || receipt.status !== 1) {
    throw new Error("Deployment transaction failed");
  }
  
  // Compute the deployed address
  const deployedAddress = await computeCreate2Address(CREATE2_DEPLOYER, salt, bytecode);
  
  // Verify code was deployed
  const code = await hre.ethers.provider.getCode(deployedAddress);
  if (code === "0x") {
    throw new Error(`No code at expected address ${deployedAddress}`);
  }
  
  return deployedAddress;
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  
  console.log("=".repeat(60));
  console.log("PoPPayoutsV2 Deterministic Deployment");
  console.log("=".repeat(60));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${signer.address}`);
  console.log(`CREATE2 Deployer: ${CREATE2_DEPLOYER}`);
  console.log(`Salt: ${SALT}`);
  console.log();

  // Load network-specific config file
  const networkName = hre.network.name;
  const configPath = path.join(__dirname, "..", "ignition", "parameters", `${networkName}.json`);

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error(`Please create ignition/parameters/${networkName}.json with the required parameters.`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const params = config.PoPPayoutsV2Module;

  const owner = params.owner;
  const supplyOwner = params.supplyOwner;
  const supplyTimestamp = params.supplyTimestamp;
  const hemiToken = params.hemiTokenContract;

  if (!owner || !supplyOwner || !supplyTimestamp || !hemiToken) {
    console.error(`Missing required parameters in ${configPath}:`);
    console.error("  owner - Contract owner address");
    console.error("  supplyOwner - Supply owner address");
    console.error("  supplyTimestamp - Unix timestamp for supply calculation");
    console.error("  hemiTokenContract - HEMI token contract address");
    process.exit(1);
  }

  console.log("Deployment Parameters:");
  console.log(`  Owner: ${owner}`);
  console.log(`  Supply Owner: ${supplyOwner}`);
  console.log(`  Supply Timestamp: ${supplyTimestamp}`);
  console.log(`  HEMI Token: ${hemiToken}`);
  console.log(`  Initial Supply: ${DEFAULT_PARAMS.initialSupply}`);
  console.log(`  Yearly Inflation: ${DEFAULT_PARAMS.initialInflationYearly} BPS`);
  console.log(`  PoP Allocation: ${DEFAULT_PARAMS.popInflationAllocation} BPS`);
  console.log(`  First Round Rewards: ${DEFAULT_PARAMS.firstRoundRewards}`);
  console.log();

  // Step 1: Deploy Factory
  console.log("Step 1: Deploying PoPPayoutsV2Factory...");
  
  const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
  const factoryBytecode = FactoryContract.bytecode;
  
  const expectedFactoryAddress = await computeCreate2Address(CREATE2_DEPLOYER, SALT, factoryBytecode);
  console.log(`  Expected address: ${expectedFactoryAddress}`);
  
  // Check if already deployed
  const existingCode = await hre.ethers.provider.getCode(expectedFactoryAddress);
  let factoryAddress: string;
  
  if (existingCode !== "0x") {
    console.log("  Factory already deployed, skipping...");
    factoryAddress = expectedFactoryAddress;
  } else {
    factoryAddress = await deployWithCreate2(SALT, factoryBytecode);
    console.log(`  Deployed to: ${factoryAddress}`);
  }
  console.log();

  // Step 2: Deploy and Initialize PoPPayoutsV2 via Factory
  console.log("Step 2: Deploying PoPPayoutsV2 via factory...");

  const factory = await hre.ethers.getContractAt("PoPPayoutsV2Factory", factoryAddress);

  // Compute expected PoPPayoutsV2 address (now only depends on salt)
  const expectedPopAddress = await factory.computeAddress(SALT);
  console.log(`  Expected address: ${expectedPopAddress}`);

  // Check if already deployed
  const existingPopCode = await hre.ethers.provider.getCode(expectedPopAddress);

  if (existingPopCode !== "0x") {
    console.log("  PoPPayoutsV2 already deployed!");
  } else {
    const tx = await factory.deployAndInitialize(
      SALT,
      owner,
      supplyOwner,
      hemiToken,
      DEFAULT_PARAMS.initialSupply,
      DEFAULT_PARAMS.initialInflationYearly,
      DEFAULT_PARAMS.popInflationAllocation,
      BigInt(supplyTimestamp),
      DEFAULT_PARAMS.firstRoundRewards
    );
    console.log(`  Transaction hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Deployed to: ${expectedPopAddress}`);
  }
  console.log();

  // Summary
  console.log("=".repeat(60));
  console.log("Deployment Complete!");
  console.log("=".repeat(60));
  console.log(`Factory:      ${factoryAddress}`);
  console.log(`PoPPayoutsV2: ${expectedPopAddress}`);
  console.log();
  console.log("These addresses will be the same on any network with the");
  console.log("standard CREATE2 deployer at 0x4e59b44847b379578588920cA78FbF26c0B4956C");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
