# PoPPayoutsV2

Solidity smart contract for the Hemi L2 blockchain that implements PoP (Proof-of-Proof) rewards distribution. The contract calculates and distributes HEMI token rewards to PoP miners based on their Bitcoin publication performance.

## Overview

PoPPayoutsV2 implements a dynamic reward algorithm that:
- Scores PoP publications based on Bitcoin block timing (quadratic decay from 100K to ~1.5K points across 9 blocks)
- Calculates reward pools using weighted averages of the past 12 rounds (1 hour of data)
- Applies resilience multipliers for low and high publication counts to quickly adjust to changes in the Bitcoin fee market
- Distributes rewards pro-rata based on PoP publication scores

## Prerequisites

- Node.js v22 or newer.
- pnpm v10 or newer.

## Installation
(note, tests are written for hardhat v2, installation of 2.26.3 used in example below)

```bash
pnpm install
```

## Build

```bash
pnpm hardhat compile
```

## Test

```bash
# Run all tests
pnpm hardhat test

# Run with gas reporting
REPORT_GAS=true pnpm hardhat test

# Run specific test by pattern
pnpm hardhat test --grep "should calculate reward"

# Run test coverage report
pnpm hardhat coverage
```

## Deployment

### Deterministic Deployment (CREATE2)

This project uses CREATE2 for deterministic deployments, meaning the contract will deploy to the **same address on any EVM chain** when using identical parameters.

#### How CREATE2 Works

The deployed contract address is determined by:
1. **CREATE2 Deployer Address** - A factory contract deployed at the same address on most EVM chains
2. **Salt** - A bytes32 value derived from `DEPLOYMENT_SALT_STRING` in `ignition/constants.ts`
3. **Contract Bytecode** - The compiled contract bytecode

Since PoPPayoutsV2 uses an `initialize()` pattern with no constructor arguments, the address depends only on the deployer, salt, and bytecode - not on initialization parameters.

#### Configuration Files

| File | Purpose |
|------|---------|
| `ignition/constants.ts` | Shared deployment constants (salt, default parameters) |
| `ignition/modules/PoPPayoutsV2.ts` | Hardhat Ignition deployment module |
| `ignition/parameters/<network>.json` | Network-specific deployment parameters |
| `hardhat.config.ts` | Network and CREATE2 strategy configuration |

#### Deployment Parameters

**Default Parameters** (defined in `ignition/constants.ts`):

| Parameter | Default Value | Description |
|-----------|---------------|-------------|
| `initialSupply` | 10,000,000,000 HEMI | Initial circulating supply |
| `initialInflationYearly` | 700 (7%) | Yearly inflation in basis points |
| `popInflationAllocation` | 500 (5%) | PoP allocation from inflation in basis points |
| `firstRoundRewards` | 100 HEMI | First round reward amount |

**Network-Specific Parameters** (must be set in `ignition/parameters/<network>.json`):

| Parameter | Description |
|-----------|-------------|
| `hemiTokenContract` | Address of the HEMI ERC20 token contract |
| `supplyOwner` | Address that can update supply parameters |
| `owner` | Address that owns the contract (can withdraw funds) |
| `supplyTimestamp` | Unix timestamp for supply calculation baseline |

#### Step-by-Step Deployment

1. **Set up environment variables:**

   ```bash
   export PRIVATE_KEY="your-deployer-private-key"

   # Optional: Override RPC URLs
   export HEMI_RPC_URL="https://rpc.hemi.network/rpc"
   export HEMI_TESTNET_RPC_URL="https://testnet.rpc.hemi.network/rpc"
   ```

2. **Create/update parameters file** for your target network:

   ```bash
   # Example: ignition/parameters/hemi.json
   ```

   ```json
   {
     "PoPPayoutsV2Module": {
       "hemiTokenContract": "0x1234567890123456789012345678901234567890",
       "supplyOwner": "0xYourSupplyOwnerAddress",
       "owner": "0xYourOwnerAddress",
       "supplyTimestamp": 1704067200
     }
   }
   ```

   > **Note:** `supplyTimestamp` must be in the past. This is the baseline timestamp for inflation calculations.

3. **Preview the deployment** (optional):

   ```bash
   pnpm hardhat run scripts/compute-address.ts
   ```

   This shows the expected deployment addresses based on the salt and bytecode.

4. **Deploy to network:**

   ```bash
   # Deploy to Hemi Mainnet
   pnpm hardhat ignition deploy ignition/modules/PoPPayoutsV2.ts \
     --network hemi \
     --parameters ignition/parameters/hemi.json \
     --strategy create2

   # Deploy to Hemi Testnet
   pnpm hardhat ignition deploy ignition/modules/PoPPayoutsV2.ts \
     --network hemiTestnet \
     --parameters ignition/parameters/hemiTestnet.json \
     --strategy create2

   # Deploy to localhost (for testing)
   pnpm hardhat ignition deploy ignition/modules/PoPPayoutsV2.ts \
     --network localhost \
     --parameters ignition/parameters/localhost.json \
     --strategy create2
   ```

5. **Verify deployment:**

   After deployment, Hardhat Ignition will output the deployed contract address. Verify it matches across networks if deploying to multiple chains.

#### Changing the Deployment Address

To deploy to a **different address**, modify the `DEPLOYMENT_SALT_STRING` in `ignition/constants.ts`:

```typescript
// Change this to deploy to a different address
export const DEPLOYMENT_SALT_STRING = "PoPPayoutsV2_v1.0.0-beta";
```

The salt is automatically converted to bytes32 using keccak256 and shared between the module and hardhat config.

#### Supported Networks

| Network | Chain ID | RPC URL |
|---------|----------|---------|
| Hemi Mainnet | 43111 | https://rpc.hemi.network/rpc |
| Hemi Testnet | 743111 | https://testnet.rpc.hemi.network/rpc |
| Localhost | 31337 | http://127.0.0.1:8545 |

### Alternative Deployment (Direct Script)

An alternative deployment script is available that uses Arachnid's deterministic-deployment-proxy directly:

```bash
pnpm hardhat run scripts/deploy.ts --network hemi
```

This script:
- Uses Arachnid's deterministic-deployment-proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`
- Deploys `PoPPayoutsV2Factory` via CREATE2
- Uses the factory to deploy and initialize `PoPPayoutsV2` atomically
- Reads network-specific parameters from `ignition/parameters/<network>.json`

> **Note:** This method uses a different CREATE2 deployer than Hardhat Ignition (which uses the CreateX factory), so the deployed addresses will differ between the two methods. Choose one method and use it consistently across all networks.

### Local Development

Start a local Hardhat node:

```bash
pnpm hardhat node
```

In another terminal, deploy:

```bash
pnpm hardhat ignition deploy ignition/modules/PoPPayoutsV2.ts \
  --network localhost \
  --parameters ignition/parameters/localhost.json \
  --strategy create2
```

## Contract Architecture

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `KEYSTONE_TIME_SEC` | 300 | Seconds between keystones (5 minutes) |
| `POP_REWARD_LOOKBACK` | 12 | Rounds of history for weighted average (1 hour) |
| `TARGET_PUBLICATION_REDUNDANCY` | 5 | Target publications per keystone |
| `MAXIMUM_BTC_PUBLICATION_DELAY` | 9 | Max Bitcoin blocks for valid publication |
| `DEPOSITOR_ACCOUNT` | `0x888...888` | Protocol-controlled caller for mintPoPRewards |

### Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `mintPoPRewards()` | onlyDepositor | Execute payout round |
| `calculateNextRewardPool()` | view | Compute reward pool for next round |
| `calculateCirculatingSupply()` | view | Supply calculation with monthly compound inflation |
| `updateSupplyInformation()` | onlySupplyOwner | Update supply parameters |
| `withdrawFunds()` | onlyOwner | Withdraw ERC20 tokens |

### Scoring Algorithm

Publication scores decay quadratically by relative Bitcoin block (relative to the first publication for that keystone):

| Relative Block | Points | Description |
|----------------|--------|-------------|
| 0 | 100,000 | First publication (optimal) |
| 1 | 100,000 | Second block (also optimal) |
| 2 | 25,000 | |
| 3 | 11,111 | |
| 4 | 6,250 | |
| 5 | 4,000 | |
| 6 | 2,778 | |
| 7 | 2,041 | |
| 8 | 1,563 | |
| 9+ | 0 | Not rewarded |

## Security

- Uses OpenZeppelin's ReentrancyGuard
- Two-step ownership transfer pattern (`updateOwnerInit`/`updateOwnerFinalize`)
- Protocol can force owner updates in emergencies
- All state-changing functions have appropriate access controls

## License

MIT
