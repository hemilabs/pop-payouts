/**
 * PoPPayoutsV2 Deterministic Deployment Module
 *
 * Uses a factory contract with CREATE2 for deterministic addresses across all networks.
 * The factory deploys and initializes the contract atomically, preventing front-running.
 *
 * Since PoPPayoutsV2 uses an initialize() pattern with no constructor arguments,
 * the deployed address depends only on the factory address and salt.
 */

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { DEFAULT_DEPLOYMENT_PARAMS, DEPLOYMENT_SALT } from "../constants";

const PoPPayoutsV2Module = buildModule("PoPPayoutsV2Module", (m) => {
  // Get deployment parameters (can be overridden via parameters file)
  const initialSupply = m.getParameter("initialSupply", DEFAULT_DEPLOYMENT_PARAMS.initialSupply);
  const initialInflationYearly = m.getParameter("initialInflationYearly", DEFAULT_DEPLOYMENT_PARAMS.initialInflationYearly);
  const popInflationAllocation = m.getParameter("popInflationAllocation", DEFAULT_DEPLOYMENT_PARAMS.popInflationAllocation);
  const firstRoundRewards = m.getParameter("firstRoundRewards", DEFAULT_DEPLOYMENT_PARAMS.firstRoundRewards);

  // These must be provided via parameters file for each network
  const owner = m.getParameter<string>("owner");
  const supplyOwner = m.getParameter<string>("supplyOwner");
  const supplyTimestamp = m.getParameter<number>("supplyTimestamp");
  const hemiTokenContract = m.getParameter<string>("hemiTokenContract");

  // Deploy the factory contract using CREATE2 for deterministic address
  const factory = m.contract("PoPPayoutsV2Factory", [], {
    id: "PoPPayoutsV2Factory_CREATE2",
  });

  // Use the factory to deploy and initialize PoPPayoutsV2 atomically
  // This prevents front-running of the initialization
  // Parameter order must match PoPPayoutsV2Factory.deployAndInitialize signature
  const deployResult = m.call(
    factory,
    "deployAndInitialize",
    [
      DEPLOYMENT_SALT,
      owner,
      supplyOwner,
      hemiTokenContract,
      initialSupply,
      initialInflationYearly,
      popInflationAllocation,
      supplyTimestamp,
      firstRoundRewards,
    ],
    {
      id: "deployAndInitialize",
    }
  );

  return { factory, deployResult };
});

export default PoPPayoutsV2Module;
