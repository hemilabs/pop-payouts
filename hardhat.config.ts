import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { DEPLOYMENT_SALT } from "./ignition/constants";

// Load environment variables for deployment
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const HEMI_RPC_URL = process.env.HEMI_RPC_URL || "https://rpc.hemi.network/rpc";
const HEMI_TESTNET_RPC_URL = process.env.HEMI_TESTNET_RPC_URL || "https://testnet.rpc.hemi.network/rpc";

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.29',
    settings: {
      evmVersion: 'cancun',
      optimizer: {
        enabled: true,
        runs: 200,
      },
    }
  },
  networks: {
    // Hemi Mainnet
    hemi: {
      url: HEMI_RPC_URL,
      accounts: [PRIVATE_KEY],
      chainId: 43111,
    },
    // Hemi Testnet
    hemiTestnet: {
      url: HEMI_TESTNET_RPC_URL,
      accounts: [PRIVATE_KEY],
      chainId: 743111,
    },
    // Local development
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
  ignition: {
    // Use CREATE2 strategy for deterministic deployments
    strategyConfig: {
      create2: {
        // Salt is derived from DEPLOYMENT_SALT_STRING in ignition/constants.ts
        salt: DEPLOYMENT_SALT,
      },
    },
  },
};

export default config;
