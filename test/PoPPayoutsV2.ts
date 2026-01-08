import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

/**
 * Most of the tests use "hard-coded" calculations/structure which are repetitive but protect
 * against a change to a dynamic calculation algorithm from missing bugs.
 * 
 * The more complex tests and fuzzing tests use helper functions to replicate expected
 * calculations.
 */

// Do not run gas estimation tests when coverage is enabled, since coverage causes gas
// calculations to be inaccurate and incorrectly fail
const itCoverageDisabled = hre.__SOLIDITY_COVERAGE_RUNNING ? it.skip : it;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const INITIAL_SUPPLY = hre.ethers.parseUnits("10000000000", 18);
const INITIAL_REWARD = hre.ethers.parseUnits("100", 18);
const INITIAL_PAYOUT_TOKENS = hre.ethers.parseUnits("10000000", 18);


const ERC20_MAX_SUPPLY = BigInt("100000000000000000000000000000000000000"); // 1e38
const ERC20_MIN_SUPPLY = BigInt("1000000000000000000000000"); // 1e24
const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

const YEARLY_TOKEN_INFLATION = 700;
const POP_INFLATION_ALLOCATION = 500;

const BLOCK_TIME_SEC = 12;

const KEYSTONE_FREQUENCY = 25;

const MINTAGE_PERIOD = 86400 * 30; // 30 days

const PROTOCOL_ADDRESS = "0x8888888888888888888888888888888888888888";

// Impersonated signers
const zeroSigner = hre.ethers.getImpersonatedSigner(ZERO_ADDRESS);
const protocolSigner = hre.ethers.getImpersonatedSigner(PROTOCOL_ADDRESS);

const INITIAL_RANDOM_TOKEN_SUPPLY = hre.ethers.parseUnits("50000000", 18);

const MAXIMUM_INITIAL_REWARD = 4753213172104342535554n;

// Replicating here so tests can identify unexpected scores rather than trusting
// scores in contract directly.
const publicationHeightScores = [
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

const rewardLookbackWeighting = [
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

const TARGET_SCORE = BigInt(500000); // 5 * publicationHeightScores[0]

const ERC20_MATH_MULTIPLIER = hre.ethers.parseUnits("1", 18);

const BPS = BigInt(10000);

var deploymentTimestamp;

async function measureGas(fn: () => Promise<any>) {
  const tx = await fn();       // run the call using whatever caller you decide
  const receipt = await tx.wait();
  return receipt!.gasUsed;
}

async function calculateCirculatingSupply(supplyTimestamp: number, supplyBase: bigint, yearlyInflation: number, timestamp: number): bigint {
  const RefSupplyCalculatorFactory = await hre.ethers.getContractFactory("RefSupplyCalculator");
  const RefSupplyCalculatorContract = await RefSupplyCalculatorFactory.deploy(
      supplyTimestamp,
      supplyBase,
      yearlyInflation
  );

  var value = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(timestamp);
  return value;
}

async function calculateMaximumRewardPool(supplyTimestamp: number, supplyBase: bigint, yearlyInflation: number, popInflation: number, rewardTimestamp: number) {
  var currentSupply = await calculateCirculatingSupply(supplyTimestamp, supplyBase, yearlyInflation, rewardTimestamp);

  // Instead of 365.25 * 86400 * BPS
  var nextMonthPoPEmissions = ((currentSupply * BigInt(popInflation) * BigInt(MINTAGE_PERIOD))) / BigInt(36525 * 86400 * 100);

  var popEmissionsPerKeystone = nextMonthPoPEmissions / BigInt(MINTAGE_PERIOD / BLOCK_TIME_SEC / KEYSTONE_FREQUENCY);

  // console.log("Maximum reward pool: %d", popEmissionsPerKeystone);
  return popEmissionsPerKeystone;
}

// Accepts a rewardsAndScores array, which contains per-round round rewards and corresponding
// PoP scores. Last value is always most recent.
// Assumes rewardsAndScores[n][0] == -1n means a placeholder (non-existent) round
async function calculateRoundRewardPool(rewardsAndScores: bigint[][], supplyTimestamp: number, supplyBase: bigint, yearlyInflation: number, popInflation: number, rewardTimestamp: number): bigint {
  if (rewardsAndScores[rewardsAndScores.length - 1][0] == -1n) {
    return INITIAL_REWARD; // No reward rounds yet, first round is initial reward
  }

  // console.log("rewardsAndScores: %o" + rewardsAndScores);

  // Calculate the numerator and denominator of the reward pool
  var numerator = 0n;
  var denominator = 0n;
  var countup = 0;
  for (let i = rewardsAndScores.length - 1; i >= 0; i--) {
    // console.log("i: %d", i);
    var rewardPool = rewardsAndScores[i][0];
    var score = rewardsAndScores[i][1];

    if (rewardPool == -1n) {
      break;
    }

    // console.log("rewardPool: %d", rewardPool);
    // console.log(typeof rewardPool);

    var adjustedRewardPool = BigInt(rewardPool * 10n); // Default assumption if score == 0

    if (score != 0n) {
      adjustedRewardPool = (rewardPool * ((TARGET_SCORE * BPS) / BigInt(score))) / BPS;
    }

    numerator += adjustedRewardPool * BigInt(rewardLookbackWeighting[countup]);
    denominator += BigInt(rewardLookbackWeighting[countup]);

    countup++;

    if (countup >= rewardLookbackWeighting.length) {
      break;
    }
  }

  var result = numerator / denominator;

  var maximumRewardPool = await calculateMaximumRewardPool(supplyTimestamp, supplyBase, yearlyInflation, popInflation, rewardTimestamp);

  if (result > maximumRewardPool) {
    result = maximumRewardPool;
  }

  return result;
}

function calculateRandomAddressesAndWeights(addrList: HDNodeWallet[], maxNumAddresses: number, maxHeight: number): {addresses: string[]; heights: number[] } {
  var count = Math.floor(Math.random() * maxNumAddresses);
  if (count < 1) {
    count = 1;
  }
  var heights: number[] = Array.from({ length: count }, () => Math.floor(Math.random() * maxHeight));

  // Make sure at least one of the heights is zero
  const zeroValueIndex = Math.floor(Math.random() * count);
  heights[zeroValueIndex] = 0;

  var addresses = new Array(count).fill("");
  for (let i = 0; i < addresses.length; i++) {
    const addrIndex = Math.floor(Math.random() * addrList.length);
    addresses[i] = addrList[addrIndex].address;
  }

  return {
    heights: heights,
    addresses: addresses,
  };
}

describe("PoPPayoutsV2", function () {

    async function fundExternalAddresses() {
      // Required for paying fees
      await hre.network.provider.send("hardhat_setBalance", [
          ZERO_ADDRESS,
          hre.ethers.toBeHex(hre.ethers.parseEther("1").toString()), // must be a hex string
      ]);
      
      // Normally the protocol on Hemi can construct transactions from the protocol address with no fees
      await hre.network.provider.send("hardhat_setBalance", [
          PROTOCOL_ADDRESS,
          hre.ethers.toBeHex(hre.ethers.parseEther("1").toString()), // must be a hex string
      ]);
    }

    async function getAddresses() {
        await fundExternalAddresses();
        const [ hemiTokenOwner, initialMintReceiver, supplyOwner, owner, initialRandomTokenReceiver, random1, random2, random3, random4 ] = await hre.ethers.getSigners();
        return { hemiTokenOwner, initialMintReceiver, supplyOwner, owner, initialRandomTokenReceiver, random1, random2, random3, random4 }
    }

    async function deployHemiToken() {
        // Note: the PoPPayoutsV2 contract will run on the L2 so it won't actually use this version of the Hemi token contract,
        // it'll just use the OptimismMintableERC20 equivalent. But we use the Hemi token contract so we can compare emissions
        // config, and just re-use it as a generic ERC20 for the rest of our testing purposes.
        const { hemiTokenOwner, initialMintReceiver, supplyOwner, owner } = await getAddresses();

        const HemiFactory = await hre.ethers.getContractFactory("Hemi");
        const HemiContract = await HemiFactory.deploy(
          hemiTokenOwner.address,
          initialMintReceiver.address,
          YEARLY_TOKEN_INFLATION // Initial inflation of 7%
        );

        return { HemiContract };
    }

    async function deployRandomToken() {
        const { initialRandomTokenReceiver } = await getAddresses();

        const RandomERC20Factory = await hre.ethers.getContractFactory("MockERC20");
        const RandomERC20Contract = await RandomERC20Factory.deploy(
          initialRandomTokenReceiver,
          INITIAL_RANDOM_TOKEN_SUPPLY
        );

        return { RandomERC20Contract, initialRandomTokenReceiver };
    }

    async function deployPoPPayoutsV2Contract() {
      const { HemiContract} = await deployHemiToken();

      const { hemiTokenOwner, initialMintReceiver, supplyOwner, owner, random1, random2, random3, random4 } = await getAddresses();

      const supplyTimestamp = await time.latest();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
          owner.address,
          supplyOwner.address,
          HemiContract,
          INITIAL_SUPPLY, // initial supply (10B tokens)
          YEARLY_TOKEN_INFLATION, // initial yearly inflation
          POP_INFLATION_ALLOCATION, // initial PoP inflation allocation
          supplyTimestamp, // initial supply timestamp
          INITIAL_REWARD // initial reward (100 tokens)
      );

      return { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, random3, random4, supplyTimestamp };
    }


    async function deployPoPPayoutsV2AndRandomTokenContracts() {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, random3, random4, supplyTimestamp } = await deployPoPPayoutsV2Contract();

        const { RandomERC20Contract, initialRandomTokenReceiver } = await deployRandomToken();

        return { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, random3, random4, RandomERC20Contract, initialRandomTokenReceiver, supplyTimestamp };
    }

  describe("Deployment", function () {
    it("Initial supply below minimum (ERC20_MIN_SUPPLY) should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);

      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");

      // Use minimal firstRoundRewards (1 wei) for supply validation tests
      // to avoid triggering the max reward check with small supplies
      const minimalReward = 1n;

      // Zero supply should revert
      const contract1 = await PoPPayoutsV2Factory.deploy();
      await expect(contract1.initialize(
          owner.address, supplyOwner.address, HemiContract,
          0, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, minimalReward
      )).to.be.revertedWith("initial supply too small for numerical precision");

      // Supply just below minimum (1e24 - 1) should also revert
      const contract2 = await PoPPayoutsV2Factory.deploy();
      await expect(contract2.initialize(
          owner.address, supplyOwner.address, HemiContract,
          hre.ethers.parseUnits("999999", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, minimalReward
      )).to.be.revertedWith("initial supply too small for numerical precision");

      // Exactly minimum supply (1e24 = 1 million tokens) should succeed
      const contract3 = await PoPPayoutsV2Factory.deploy();
      await contract3.initialize(
          owner.address, supplyOwner.address, HemiContract,
          hre.ethers.parseUnits("1000000", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, minimalReward
      );
      expect(await contract3.supplyBase()).to.equal(hre.ethers.parseUnits("1000000", 18));
    });
    it("Too high inflation should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, 701, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("initial inflation is too high");
    });
    it("Too high PoP inflation allocation should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, 501, now, INITIAL_REWARD
      )).to.be.revertedWith("PoP inflation is too high");
    });
    it("PoP inflation allocation above MAX_POP_INFLATION_ALLOCATION should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, 700, 501, now, INITIAL_REWARD
      )).to.be.revertedWith("PoP inflation is too high");
    });
    it("PoP inflation allocation above yearly inflation should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      // _popInflationAllocation (500) <= MAX_POP_INFLATION_ALLOCATION (500) - passes
      // _popInflationAllocation (500) > _initialInflationYearly (400) - fails
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, 400, 500, now, INITIAL_REWARD
      )).to.be.revertedWith("PoP inflation must be less than or equal to initial inflation");
    });
    it("supply timestamp in future should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();

      // Get the current timestamp right before the initialize call
      const currentTimestamp = await time.latest();
      // Use a timestamp far in the future (1 day from now)
      const futureTimestamp = currentTimestamp + 86400;

      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, futureTimestamp, INITIAL_REWARD
      )).to.be.revertedWith("supply timestamp must be in the past");
    });
    it("zero-address HEMI token should revert", async function () {
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, ZERO_ADDRESS,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("hemi token contract cannot be zero address");
    });
    it("EOA address for HEMI token should revert", async function () {
      const { supplyOwner, owner, random1 } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, random1.address,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("hemi token address must contain contract code");
    });
    it("zero-address initial supply owner should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, ZERO_ADDRESS, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("supply owner cannot be zero address");
    });
    it("zero-address initial owner should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          ZERO_ADDRESS, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("owner cannot be zero address");
    });
    it("Re-initialization should revert after contract is already initialized", async function () {
      const { PoPPayoutsV2Contract, owner, supplyOwner, HemiContract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Contract is already initialized by the fixture, attempting to initialize again should fail
      await expect(PoPPayoutsV2Contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      )).to.be.revertedWith("contract already initialized");

      // Even with different addresses, re-initialization should fail
      const randomAddress = "0x1111111111111111111111111111111111111111";
      await expect(PoPPayoutsV2Contract.initialize(
          randomAddress, randomAddress, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      )).to.be.revertedWith("contract already initialized");
    });
    it("Initial supply exceeding ERC20_MAX_SUPPLY should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      // ERC20_MAX_SUPPLY = 1e20 * 1e18 = 1e38, so use a value larger than that
      const tooLargeSupply = hre.ethers.parseUnits("1", 56);
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          tooLargeSupply, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, INITIAL_REWARD
      )).to.be.revertedWith("initial supply too large");
    });
    it("Zero first round rewards should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, 0
      )).to.be.revertedWith("first round rewards cannot be zero");
    });
    it("First round rewards exceeding maximum allowed by inflation should revert", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const now = await time.latest();

      time.increaseTo(now + 1);

      // Calculate the maximum reward pool to determine an excessive value
      // Max reward = (supply * popInflation * 30 days) / (365.25 days * 10000) / 8640
      // With 10B supply, 5% PoP allocation: ~47,564 tokens per keystone
      const excessiveReward = hre.ethers.parseUnits("1000000000", 18); // 1 billion tokens - way over max

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();
      await expect(contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now, excessiveReward
      )).to.be.revertedWith("first round rewards exceed maximum allowed by inflation");
    });
    it("Should set the right owner", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });
    it("Should set the right supply owner", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });
    it("Should set the right ERC20 token", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.hemiTokenContract()).to.equal(HemiContract);
    });
    it("Should set the right initial supply", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(INITIAL_SUPPLY);
    });
    it("Should set the right initial inflation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION);
    });
    it("Should set the right initial pop inflation allocation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION);
    });
    it("Should set the right initial supply timestamp", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp);
    });
    it("Should set the right first round reward", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.firstRoundRewards()).to.equal(INITIAL_REWARD);
    });
    it("Should not be a pending owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
    });
    it("Should not be a pending supply owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
    });
    it("Should emit initialization events on deployment and initialization", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const supplyTimestamp = await time.latest();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize and check all events (now all emitted during initialize)
      const initTx = await PoPPayoutsV2Contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      );

      await expect(initTx)
        .to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(0, INITIAL_SUPPLY)
        .to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(0, YEARLY_TOKEN_INFLATION)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(0, POP_INFLATION_ALLOCATION)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(0, supplyTimestamp)
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(ZERO_ADDRESS, owner.address)
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(ZERO_ADDRESS, supplyOwner.address)
        .to.emit(PoPPayoutsV2Contract, "ContractInitialized").withArgs(owner.address, supplyOwner.address, await HemiContract.getAddress());
    });
    it("Should emit SupplyBaseUpdated with zero as old value on deployment", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner } = await getAddresses();

      const supplyTimestamp = await time.latest();
      const customSupply = hre.ethers.parseUnits("5000000000", 18); // 5 billion

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      const initTx = await PoPPayoutsV2Contract.initialize(
          owner.address, supplyOwner.address, HemiContract,
          customSupply, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      );

      await expect(initTx)
        .to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(0, customSupply);
    });
    it("Should emit OwnerUpdateCompleted with zero address as old owner on initialization", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner, random1 } = await getAddresses();

      const supplyTimestamp = await time.latest();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize with random1 as owner to verify the event args
      const initTx = await PoPPayoutsV2Contract.initialize(
          random1.address, supplyOwner.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      );

      await expect(initTx)
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(ZERO_ADDRESS, random1.address);
    });
    it("Should emit SupplyOwnerUpdateCompleted with zero address as old supply owner on initialization", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner, random2 } = await getAddresses();

      const supplyTimestamp = await time.latest();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize with random2 as supply owner to verify the event args
      const initTx = await PoPPayoutsV2Contract.initialize(
          owner.address, random2.address, HemiContract,
          INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp, INITIAL_REWARD
      );

      await expect(initTx)
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(ZERO_ADDRESS, random2.address);
    });

    it("should return correct PUBLICATION_HEIGHT_SCORES values for all indices", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Verify all 9 array elements match expected scores
      for (let i = 0; i < publicationHeightScores.length; i++) {
        const contractValue = await PoPPayoutsV2Contract.PUBLICATION_HEIGHT_SCORES(i);
        expect(contractValue).to.equal(BigInt(publicationHeightScores[i]),
          `PUBLICATION_HEIGHT_SCORES[${i}] mismatch`);
      }
    });

    it("should return correct REWARD_LOOKBACK_WEIGHTING values for all indices", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Verify all 12 array elements match expected weights
      for (let i = 0; i < rewardLookbackWeighting.length; i++) {
        const contractValue = await PoPPayoutsV2Contract.REWARD_LOOKBACK_WEIGHTING(i);
        expect(contractValue).to.equal(BigInt(rewardLookbackWeighting[i]),
          `REWARD_LOOKBACK_WEIGHTING[${i}] mismatch`);
      }
    });

    it("should return correct hemiTokenContract address", async function () {
      const { PoPPayoutsV2Contract, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const tokenAddress = await PoPPayoutsV2Contract.hemiTokenContract();
      const expectedAddress = await HemiContract.getAddress();

      expect(tokenAddress).to.equal(expectedAddress);
    });

    it("should return correct firstRoundRewards value", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const firstReward = await PoPPayoutsV2Contract.firstRoundRewards();

      expect(firstReward).to.equal(INITIAL_REWARD);
    });

    it("should return correct erc20SupplyCalculationMultiplicationFactor", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const factor = await PoPPayoutsV2Contract.erc20SupplyCalculationMultiplicationFactor();

      // Factor should be ERC20_ROUNDING_ERROR_FACTOR * (supplyBase / ERC20_ROUNDING_ERROR_FACTOR)
      const ERC20_ROUNDING_ERROR_FACTOR = BigInt("1000000000000000000"); // 1e18
      const expectedFactor = ERC20_ROUNDING_ERROR_FACTOR * (INITIAL_SUPPLY / ERC20_ROUNDING_ERROR_FACTOR);

      expect(factor).to.equal(expectedFactor);
    });

    it("should return correct constant values", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Verify key constants
      expect(await PoPPayoutsV2Contract.MINTAGE_PERIOD()).to.equal(30 * 24 * 60 * 60); // 30 days in seconds
      expect(await PoPPayoutsV2Contract.POP_REWARD_LOOKBACK()).to.equal(12);
      expect(await PoPPayoutsV2Contract.KEYSTONE_FREQUENCY()).to.equal(25);
      expect(await PoPPayoutsV2Contract.BLOCK_TIME_SEC()).to.equal(12);
      expect(await PoPPayoutsV2Contract.KEYSTONE_TIME_SEC()).to.equal(300); // 25 * 12
      expect(await PoPPayoutsV2Contract.KEYSTONES_PER_DAY()).to.equal(288); // 86400 / 300
      expect(await PoPPayoutsV2Contract.MAXIMUM_REWARD_POINTS_PER_PUBLICATION()).to.equal(100000);
      expect(await PoPPayoutsV2Contract.TARGET_PUBLICATION_REDUNDANCY()).to.equal(5);
      expect(await PoPPayoutsV2Contract.POP_KEYSTONE_PUBLICATION_TARGET()).to.equal(500000);
      expect(await PoPPayoutsV2Contract.MAXIMUM_BTC_PUBLICATION_DELAY()).to.equal(9);
      expect(await PoPPayoutsV2Contract.MAXIMUM_PUBLICATIONS_PER_KEYSTONE()).to.equal(75);
      expect(await PoPPayoutsV2Contract.MAXIMUM_SKIPPED_ROUND_RECALCULATION()).to.equal(24);
      expect(await PoPPayoutsV2Contract.RETARGETING_MULTIPLIER_NO_SCORE()).to.equal(100000); // 10 * 10000
      expect(await PoPPayoutsV2Contract.DEPOSITOR_ACCOUNT()).to.equal(PROTOCOL_ADDRESS);
      expect(await PoPPayoutsV2Contract.MAX_SUPPLY_INFLATION_YEARLY()).to.equal(700);
      expect(await PoPPayoutsV2Contract.MAX_POP_INFLATION_ALLOCATION()).to.equal(500);
      expect(await PoPPayoutsV2Contract.ERC20_ROUNDING_ERROR_FACTOR()).to.equal(BigInt("1000000000000000000"));
      expect(await PoPPayoutsV2Contract.ERC20_MAX_SUPPLY()).to.equal(BigInt("100000000000000000000000000000000000000"));
      expect(await PoPPayoutsV2Contract.ERC20_MIN_SUPPLY()).to.equal(BigInt("1000000000000000000000000"));
    });

    it("should handle contract deployed with maximum allowed supply (ERC20_MAX_SUPPLY)", async function () {
      const [owner, supplyOwner, initialMintReceiver] = await hre.ethers.getSigners();

      // Deploy MockERC20 with max supply
      const MockERC20Factory = await hre.ethers.getContractFactory("MockERC20");
      const TokenContract = await MockERC20Factory.deploy(initialMintReceiver.address, ERC20_MAX_SUPPLY);
      await TokenContract.waitForDeployment();
      const tokenAddress = await TokenContract.getAddress();

      const currentTimestamp = await time.latest();
      const supplyTimestamp = currentTimestamp - 100;

      // Deploy PoPPayoutsV2 with empty constructor, then initialize with all params
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();
      await PoPPayoutsV2Contract.waitForDeployment();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
        owner.address,
        supplyOwner.address,
        tokenAddress,
        ERC20_MAX_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp,
        INITIAL_REWARD
      );

      const contractAddress = await PoPPayoutsV2Contract.getAddress();

      // Fund the contract
      await TokenContract.connect(initialMintReceiver).transfer(contractAddress, ERC20_MAX_SUPPLY / 2n);

      // Verify deployment succeeded
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(ERC20_MAX_SUPPLY);

      // Advance time and mine blocks
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Get a valid keystone
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // First payout should work
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(1n);
    });

    it("should handle contract deployed with minimum allowed supply (ERC20_MIN_SUPPLY)", async function () {
      const [owner, supplyOwner, initialMintReceiver] = await hre.ethers.getSigners();

      // Deploy MockERC20 with min supply
      const MockERC20Factory = await hre.ethers.getContractFactory("MockERC20");
      const TokenContract = await MockERC20Factory.deploy(initialMintReceiver.address, ERC20_MIN_SUPPLY);
      await TokenContract.waitForDeployment();
      const tokenAddress = await TokenContract.getAddress();

      const currentTimestamp = await time.latest();
      const supplyTimestamp = currentTimestamp - 100;

      // For minimum supply (1e24), we need a proportionally smaller first round reward
      // The max first round reward is calculated based on supply and inflation
      // ERC20_MIN_SUPPLY is 1e24 (1M tokens with 18 decimals)
      // With 7% yearly inflation and 5% PoP allocation, first round reward should be very small
      // Let's use a safe small value: 1e15 (0.001 tokens)
      const minSupplyFirstReward = BigInt("1000000000000000"); // 0.001 tokens

      // Deploy PoPPayoutsV2 with empty constructor, then initialize with all params
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();
      await PoPPayoutsV2Contract.waitForDeployment();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
        owner.address,
        supplyOwner.address,
        tokenAddress,
        ERC20_MIN_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp,
        minSupplyFirstReward
      );

      const contractAddress = await PoPPayoutsV2Contract.getAddress();

      // Fund the contract with enough for payouts
      await TokenContract.connect(initialMintReceiver).transfer(contractAddress, ERC20_MIN_SUPPLY / 2n);

      // Verify deployment succeeded
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(ERC20_MIN_SUPPLY);

      // Advance time and mine blocks
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Get a valid keystone
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // First payout should work
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(1n);
    });
  });

  describe("Factory Deployment", function () {
    it("should deploy and initialize contract atomically", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_1"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();

      // Find the deployed address from the event
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const deployedAddress = parsed?.args[0];

      // Verify the deployed contract is properly initialized
      const PoPPayoutsV2 = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);
      expect(await PoPPayoutsV2.owner()).to.equal(owner.address);
      expect(await PoPPayoutsV2.supplyOwner()).to.equal(supplyOwner.address);
      expect(await PoPPayoutsV2.hemiTokenContract()).to.equal(HemiContract);
    });

    it("should emit PoPPayoutsV2Deployed event with correct parameters", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_2"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.emit(factory, "PoPPayoutsV2Deployed")
        .withArgs(
          (addr: string) => hre.ethers.isAddress(addr), // deployed address
          owner.address,
          supplyOwner.address,
          salt
        );
    });

    it("computeAddress should predict the correct deployment address", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_3"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Predict the address before deployment (now only takes salt)
      const predictedAddress = await factory.computeAddress(salt);

      // Deploy and get actual address
      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const actualAddress = parsed?.args[0];

      expect(predictedAddress).to.equal(actualAddress);
    });

    it("same salt and parameters should produce same address (deterministic)", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_deterministic"));

      // Deploy two separate factories
      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory1 = await FactoryContract.deploy();
      const factory2 = await FactoryContract.deploy();

      // Compute addresses from both factories with same salt
      const address1 = await factory1.computeAddress(salt);
      const address2 = await factory2.computeAddress(salt);

      // Different factories = different addresses (factory address is part of CREATE2)
      expect(address1).to.not.equal(address2);

      // But same factory with same salt = same address
      const address1Again = await factory1.computeAddress(salt);
      expect(address1).to.equal(address1Again);
    });

    it("different salt should produce different address", async function () {
      const salt1 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("salt_a"));
      const salt2 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("salt_b"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const address1 = await factory.computeAddress(salt1);
      const address2 = await factory.computeAddress(salt2);

      expect(address1).to.not.equal(address2);
    });

    it("deploying with same salt twice should revert and preserve existing contract state", async function () {
      const { supplyOwner, owner, HemiContract, initialMintReceiver, random1 } = await loadFixture(deployPoPPayoutsV2Contract);
      const newOwner = random1; // Use a random signer that's guaranteed to be different from owner

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_reuse"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // First deployment succeeds
      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const deployedAddress = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data })?.args[0];

      // Get a reference to the deployed contract
      const contract = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);

      // === Modify the contract's state ===

      // 1. Fund the contract with HEMI tokens
      const fundAmount = hre.ethers.parseUnits("1000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(deployedAddress, fundAmount);

      // 2. Initiate an owner update (creates pending state)
      await contract.connect(owner).updateOwnerInit(newOwner.address);

      // === Record state before failed redeployment ===
      const balanceBefore = await HemiContract.balanceOf(deployedAddress);
      const pendingOwnerBefore = await contract.pendingOwner();
      const ownerBefore = await contract.owner();
      const supplyOwnerBefore = await contract.supplyOwner();
      const roundsCountBefore = await contract.getRoundsCount();

      // Verify state was actually modified
      expect(balanceBefore).to.equal(fundAmount);
      expect(pendingOwnerBefore).to.equal(newOwner.address);

      // === Attempt second deployment with same salt (should fail) ===
      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.reverted;

      // === Verify contract state is completely unchanged after failed redeployment ===
      const balanceAfter = await HemiContract.balanceOf(deployedAddress);
      const pendingOwnerAfter = await contract.pendingOwner();
      const ownerAfter = await contract.owner();
      const supplyOwnerAfter = await contract.supplyOwner();
      const roundsCountAfter = await contract.getRoundsCount();

      expect(balanceAfter).to.equal(balanceBefore, "Balance should be unchanged");
      expect(pendingOwnerAfter).to.equal(pendingOwnerBefore, "Pending owner should be unchanged");
      expect(ownerAfter).to.equal(ownerBefore, "Owner should be unchanged");
      expect(supplyOwnerAfter).to.equal(supplyOwnerBefore, "Supply owner should be unchanged");
      expect(roundsCountAfter).to.equal(roundsCountBefore, "Rounds count should be unchanged");

      // Verify the contract is still fully functional by completing the pending owner update
      await contract.connect(newOwner).updateOwnerFinalize();
      expect(await contract.owner()).to.equal(newOwner.address);

      // Also verify payout functionality still works
      // Mine enough blocks to have a valid keystone
      await hre.network.provider.send("hardhat_mine", ["0x64"]); // Mine 100 blocks

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Advance time past keystone period
      await time.increase(300);

      // Set up depositor
      const depositorAddress = "0x8888888888888888888888888888888888888888";
      await hre.network.provider.send("hardhat_setBalance", [depositorAddress, "0x56BC75E2D63100000"]);
      const depositor = await hre.ethers.getImpersonatedSigner(depositorAddress);

      // Execute a payout round with some test publications
      const testAddresses = [owner.address, newOwner.address];
      const testHeights = [0, 1]; // Relative publication heights

      await contract.connect(depositor).mintPoPRewards(keystone, testAddresses, testHeights);

      // Verify the round was recorded (should be one more than before)
      expect(await contract.getRoundsCount()).to.equal(roundsCountBefore + 1n);
    });

    it("should revert if initialization parameters are invalid", async function () {
      const { supplyOwner, owner } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_invalid"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Zero address for hemiTokenContract should fail
      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        ZERO_ADDRESS,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("hemi token contract cannot be zero address");
    });

    it("deployed contract should be fully functional", async function () {
      const { supplyOwner, owner, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_functional"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const deployedAddress = parsed?.args[0];

      const PoPPayoutsV2Contract = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);

      // Fund the contract
      const HemiContractSigner = await hre.ethers.getContractAt("Hemi", await HemiContract.getAddress());
      await HemiContractSigner.connect(initialMintReceiver).transfer(deployedAddress, INITIAL_PAYOUT_TOKENS);

      // Advance time and blocks
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      // Execute a payout round
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        50,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(1n);
    });

    it("should revert if owner is zero address", async function () {
      const { supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_zero_owner"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        ZERO_ADDRESS,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("owner cannot be zero address");
    });

    it("should revert if supplyOwner is zero address", async function () {
      const { owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_zero_supply_owner"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        ZERO_ADDRESS,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("supply owner cannot be zero address");
    });

    it("should revert if hemiToken is EOA (no code)", async function () {
      const { owner, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_eoa_token"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Use an EOA address (no contract code)
      const eoaAddress = "0x1111111111111111111111111111111111111111";

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        eoaAddress,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("hemi token address must contain contract code");
    });

    it("same salt produces same address regardless of initialization parameters", async function () {
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_same_params"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Since constructor is empty, computeAddress only depends on salt
      // All calls with the same salt should return the same address
      const address1 = await factory.computeAddress(salt);
      const address2 = await factory.computeAddress(salt);

      // Same salt = same address (regardless of what init params would be used)
      expect(address1).to.equal(address2);
    });

    it("CROSS-CHAIN DETERMINISM: same salt with different init params produces same address across chain resets", async function () {
      // This test simulates deploying on two different chains by:
      // 1. Using DIFFERENT deployers on each chain
      // 2. Using hardhat_setCode to place factory at same address (simulating CREATE2 deployer)
      // 3. Verifying PoPPayoutsV2 address depends on factory address + salt, NOT the original deployer

      // Take cleanup snapshot to restore state for subsequent tests
      const cleanupSnapshotId = await hre.network.provider.send("evm_snapshot");

      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("cross_chain_deterministic_salt"));

      // Use DIFFERENT deployers to prove the result doesn't depend on who deployed the factory
      const [deployer1, deployer2, owner1, supplyOwner1, owner2, supplyOwner2] = await hre.ethers.getSigners();

      // Take a snapshot before any deployments (for chain reset simulation)
      const snapshotId = await hre.network.provider.send("evm_snapshot");

      // ============ CHAIN A: Deployer1 deploys everything ============
      const HemiFactoryA = await hre.ethers.getContractFactory("Hemi");
      const HemiA = await HemiFactoryA.connect(deployer1).deploy(deployer1.address, deployer1.address, YEARLY_TOKEN_INFLATION);

      const FactoryContractA = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factoryA = await FactoryContractA.connect(deployer1).deploy();
      const factoryAddressA = await factoryA.getAddress();

      // Get the factory bytecode for later
      const factoryBytecode = await hre.ethers.provider.getCode(factoryAddressA);

      const nowA = await time.latest();

      // Params for Chain A: high supply, max inflation
      const paramsA = {
        supply: INITIAL_SUPPLY * 2n,
        inflation: 700,
        popAllocation: 500,
        timestamp: nowA,
        reward: hre.ethers.parseUnits("500", 18)
      };

      const txA = await factoryA.deployAndInitialize(
        salt,
        owner1.address,
        supplyOwner1.address,
        HemiA,
        paramsA.supply,
        paramsA.inflation,
        paramsA.popAllocation,
        paramsA.timestamp,
        paramsA.reward
      );
      const receiptA = await txA.wait();
      const eventA = receiptA?.logs.find(log => {
        try {
          return factoryA.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const deployedAddressA = factoryA.interface.parseLog({ topics: [...eventA!.topics], data: eventA!.data })?.args[0];

      // Verify Chain A contract has correct params
      const contractA = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddressA);
      expect(await contractA.supplyBase()).to.equal(paramsA.supply);
      expect(await contractA.supplyInflationYearly()).to.equal(paramsA.inflation);
      expect(await contractA.owner()).to.equal(owner1.address);

      // ============ REVERT TO SIMULATE CHAIN B ============
      await hre.network.provider.send("evm_revert", [snapshotId]);

      // ============ CHAIN B: DIFFERENT deployer, but factory at SAME address ============
      // This simulates what happens when using a standard CREATE2 deployer like Arachnid's
      // The factory ends up at the same address regardless of who calls the CREATE2 deployer

      // First, deployer2 deploys Hemi (will be at different address, that's fine)
      const HemiFactoryB = await hre.ethers.getContractFactory("Hemi");
      const HemiB = await HemiFactoryB.connect(deployer2).deploy(deployer2.address, deployer2.address, YEARLY_TOKEN_INFLATION);

      // Use hardhat_setCode to place factory at the SAME address as Chain A
      // This simulates the factory being deployed via CREATE2 deployer
      await hre.network.provider.send("hardhat_setCode", [factoryAddressA, factoryBytecode]);

      // Get a reference to the factory at the same address
      const factoryB = await hre.ethers.getContractAt("PoPPayoutsV2Factory", factoryAddressA);

      const nowB = await time.latest();

      // Params for Chain B: COMPLETELY DIFFERENT - low supply, low inflation, different owners
      const paramsB = {
        supply: INITIAL_SUPPLY / 2n,
        inflation: 100,
        popAllocation: 50,
        timestamp: nowB,
        reward: hre.ethers.parseUnits("1", 18)
      };

      // deployer2 calls the factory (different caller than Chain A!)
      const txB = await factoryB.connect(deployer2).deployAndInitialize(
        salt, // SAME SALT
        owner2.address, // Different owner
        supplyOwner2.address, // Different supply owner
        HemiB,
        paramsB.supply, // Different supply
        paramsB.inflation, // Different inflation
        paramsB.popAllocation, // Different PoP allocation
        paramsB.timestamp,
        paramsB.reward // Different reward
      );
      const receiptB = await txB.wait();
      const eventB = receiptB?.logs.find(log => {
        try {
          return factoryB.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const deployedAddressB = factoryB.interface.parseLog({ topics: [...eventB!.topics], data: eventB!.data })?.args[0];

      // ============ THE KEY ASSERTIONS ============
      // 1. Same factory address + same salt = same deployed address
      expect(deployedAddressB).to.equal(deployedAddressA);

      // 2. This works even though:
      //    - Different deployer called the factory (deployer2 vs deployer1)
      //    - ALL init params are different
      expect(deployer1.address).to.not.equal(deployer2.address); // Confirm different deployers

      // Verify Chain B contract has its own (different) params
      const contractB = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddressB);
      expect(await contractB.supplyBase()).to.equal(paramsB.supply);
      expect(await contractB.supplyInflationYearly()).to.equal(paramsB.inflation);
      expect(await contractB.owner()).to.equal(owner2.address);

      // Confirm the params are actually different
      expect(paramsA.supply).to.not.equal(paramsB.supply);
      expect(paramsA.inflation).to.not.equal(paramsB.inflation);
      expect(owner1.address).to.not.equal(owner2.address);

      // Restore state for subsequent tests
      await hre.network.provider.send("evm_revert", [cleanupSnapshotId]);
    });

    it("CROSS-CHAIN DETERMINISM: different salts produce different addresses even with identical init params", async function () {
      // Take cleanup snapshot to restore state for subsequent tests
      const cleanupSnapshotId = await hre.network.provider.send("evm_snapshot");

      const [deployer, owner, supplyOwner] = await hre.ethers.getSigners();

      const salt1 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("network_alpha_v1"));
      const salt2 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("network_beta_v1"));

      const snapshotId = await hre.network.provider.send("evm_snapshot");

      // Deploy on "Chain 1" with salt1
      const HemiFactory1 = await hre.ethers.getContractFactory("Hemi");
      const Hemi1 = await HemiFactory1.connect(deployer).deploy(deployer.address, deployer.address, YEARLY_TOKEN_INFLATION);

      const FactoryContract1 = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory1 = await FactoryContract1.connect(deployer).deploy();

      const now1 = await time.latest();
      const params = {
        supply: INITIAL_SUPPLY,
        inflation: YEARLY_TOKEN_INFLATION,
        popAllocation: POP_INFLATION_ALLOCATION,
        timestamp: now1,
        reward: INITIAL_REWARD
      };

      const tx1 = await factory1.deployAndInitialize(
        salt1,
        owner.address,
        supplyOwner.address,
        Hemi1,
        params.supply,
        params.inflation,
        params.popAllocation,
        params.timestamp,
        params.reward
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find(log => {
        try {
          return factory1.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const address1 = factory1.interface.parseLog({ topics: [...event1!.topics], data: event1!.data })?.args[0];

      // Revert and deploy on "Chain 2" with salt2 but IDENTICAL params
      await hre.network.provider.send("evm_revert", [snapshotId]);

      const HemiFactory2 = await hre.ethers.getContractFactory("Hemi");
      const Hemi2 = await HemiFactory2.connect(deployer).deploy(deployer.address, deployer.address, YEARLY_TOKEN_INFLATION);

      const FactoryContract2 = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory2 = await FactoryContract2.connect(deployer).deploy();

      const now2 = await time.latest();

      const tx2 = await factory2.deployAndInitialize(
        salt2, // DIFFERENT SALT
        owner.address, // Same owner
        supplyOwner.address, // Same supply owner
        Hemi2,
        params.supply, // Same supply
        params.inflation, // Same inflation
        params.popAllocation, // Same PoP
        now2,
        params.reward // Same reward
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find(log => {
        try {
          return factory2.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const address2 = factory2.interface.parseLog({ topics: [...event2!.topics], data: event2!.data })?.args[0];

      // Different salt = different address (even with identical params)
      expect(address1).to.not.equal(address2);

      // Restore state for subsequent tests
      await hre.network.provider.send("evm_revert", [cleanupSnapshotId]);
    });

    it("CROSS-CHAIN DETERMINISM: manual CREATE2 address calculation matches factory result", async function () {
      const [deployer, owner, supplyOwner] = await hre.ethers.getSigners();

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.connect(deployer).deploy();
      const factoryAddress = await factory.getAddress();

      const PoPPayoutsV2Contract = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const initCodeHash = hre.ethers.keccak256(PoPPayoutsV2Contract.bytecode);

      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("manual_calc_test"));

      // Manually calculate CREATE2 address: keccak256(0xff ++ deployer ++ salt ++ keccak256(bytecode))[12:]
      const manualAddress = hre.ethers.getCreate2Address(factoryAddress, salt, initCodeHash);

      // Get address from factory's computeAddress
      const factoryComputedAddress = await factory.computeAddress(salt);

      // They should match
      expect(factoryComputedAddress.toLowerCase()).to.equal(manualAddress.toLowerCase());

      // Now actually deploy and verify the real address matches
      const HemiFactory = await hre.ethers.getContractFactory("Hemi");
      const Hemi = await HemiFactory.deploy(deployer.address, deployer.address, YEARLY_TOKEN_INFLATION);

      const now = await time.latest();
      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        Hemi,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const actualDeployedAddress = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data })?.args[0];

      // All three should match
      expect(actualDeployedAddress.toLowerCase()).to.equal(manualAddress.toLowerCase());
      expect(actualDeployedAddress.toLowerCase()).to.equal(factoryComputedAddress.toLowerCase());
    });

    it("should deploy multiple contracts from same factory, each with unique deterministic address", async function () {
      const [deployer, owner1, supplyOwner1, owner2, supplyOwner2, owner3, supplyOwner3] = await hre.ethers.getSigners();

      const HemiFactory = await hre.ethers.getContractFactory("Hemi");
      const Hemi = await HemiFactory.deploy(deployer.address, deployer.address, YEARLY_TOKEN_INFLATION);

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const salts = [
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes("deployment_1")),
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes("deployment_2")),
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes("deployment_3")),
      ];

      const owners = [
        { owner: owner1, supplyOwner: supplyOwner1 },
        { owner: owner2, supplyOwner: supplyOwner2 },
        { owner: owner3, supplyOwner: supplyOwner3 },
      ];

      // Pre-compute expected addresses
      const expectedAddresses = await Promise.all(
        salts.map(salt => factory.computeAddress(salt))
      );

      // Verify all expected addresses are unique
      const uniqueExpected = new Set(expectedAddresses.map(a => a.toLowerCase()));
      expect(uniqueExpected.size).to.equal(3, "Expected addresses should all be unique");

      // Deploy all three contracts
      const deployedAddresses: string[] = [];
      for (let i = 0; i < 3; i++) {
        const now = await time.latest();
        const tx = await factory.deployAndInitialize(
          salts[i],
          owners[i].owner.address,
          owners[i].supplyOwner.address,
          Hemi,
          INITIAL_SUPPLY,
          YEARLY_TOKEN_INFLATION,
          POP_INFLATION_ALLOCATION,
          now,
          INITIAL_REWARD
        );
        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
          } catch { return false; }
        });
        const deployedAddress = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data })?.args[0];
        deployedAddresses.push(deployedAddress);
      }

      // Verify all deployed addresses are unique
      const uniqueDeployed = new Set(deployedAddresses.map(a => a.toLowerCase()));
      expect(uniqueDeployed.size).to.equal(3, "Deployed addresses should all be unique");

      // Verify each deployed address matches its pre-computed expected address
      for (let i = 0; i < 3; i++) {
        expect(deployedAddresses[i].toLowerCase()).to.equal(
          expectedAddresses[i].toLowerCase(),
          `Deployment ${i + 1} address should match pre-computed address`
        );
      }

      // Verify each contract is properly initialized with its own owner
      for (let i = 0; i < 3; i++) {
        const contract = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddresses[i]);
        expect(await contract.owner()).to.equal(owners[i].owner.address);
        expect(await contract.supplyOwner()).to.equal(owners[i].supplyOwner.address);
      }
    });

    it("should revert if constructor parameters are invalid (supply too small)", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_small_supply"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // ERC20_MIN_SUPPLY = 1e24, use smaller value
      const tooSmallSupply = hre.ethers.parseUnits("1", 18);

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        tooSmallSupply,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("initial supply too small for numerical precision");
    });

    it("should allow anyone to deploy (no access control)", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);
      const [, , , , randomUser] = await hre.ethers.getSigners();

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_anyone"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Random user can deploy
      await expect(factory.connect(randomUser).deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.emit(factory, "PoPPayoutsV2Deployed");
    });

    // === HIGH VALUE TESTS ===

    it("deployAndInitialize return value should match deployed address", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_return_value"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // Get return value using staticCall
      const returnedAddress = await factory.deployAndInitialize.staticCall(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      // Actually deploy
      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const eventAddress = parsed?.args[0];

      expect(returnedAddress).to.equal(eventAddress);

      // Verify it's actually a contract
      const code = await hre.ethers.provider.getCode(returnedAddress);
      expect(code).to.not.equal("0x");
    });

    it("deployed contract should emit initialization events", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_init_events"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();

      // Get deployed address
      const factoryEvent = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...factoryEvent!.topics], data: factoryEvent!.data });
      const deployedAddress = parsed?.args[0];

      const PoPPayoutsV2 = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);

      // Check for ContractInitialized event
      const initEvent = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "ContractInitialized";
        } catch { return false; }
      });
      expect(initEvent).to.not.be.undefined;
      const initParsed = PoPPayoutsV2.interface.parseLog({ topics: [...initEvent!.topics], data: initEvent!.data });
      expect(initParsed?.args[0]).to.equal(owner.address);
      expect(initParsed?.args[1]).to.equal(supplyOwner.address);

      // Check for OwnerUpdateCompleted event
      const ownerEvent = receipt?.logs.find(log => {
        try {
          const p = PoPPayoutsV2.interface.parseLog({ topics: [...log.topics], data: log.data });
          return p?.name === "OwnerUpdateCompleted";
        } catch { return false; }
      });
      expect(ownerEvent).to.not.be.undefined;

      // Check for SupplyOwnerUpdateCompleted event
      const supplyOwnerEvent = receipt?.logs.find(log => {
        try {
          const p = PoPPayoutsV2.interface.parseLog({ topics: [...log.topics], data: log.data });
          return p?.name === "SupplyOwnerUpdateCompleted";
        } catch { return false; }
      });
      expect(supplyOwnerEvent).to.not.be.undefined;
    });

    it("deployed contract should have all constructor values set correctly", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_constructor_values"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const deployedAddress = parsed?.args[0];

      const PoPPayoutsV2 = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);

      // Verify all constructor/initialization values
      expect(await PoPPayoutsV2.supplyBase()).to.equal(INITIAL_SUPPLY);
      expect(await PoPPayoutsV2.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION);
      expect(await PoPPayoutsV2.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION);
      expect(await PoPPayoutsV2.supplyTimestamp()).to.equal(now);
      expect(await PoPPayoutsV2.firstRoundRewards()).to.equal(INITIAL_REWARD);
      expect(await PoPPayoutsV2.owner()).to.equal(owner.address);
      expect(await PoPPayoutsV2.supplyOwner()).to.equal(supplyOwner.address);
      expect(await PoPPayoutsV2.hemiTokenContract()).to.equal(HemiContract);
    });

    it("deployed contract cannot be re-initialized by anyone", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);
      const [, , , , randomUser] = await hre.ethers.getSigners();

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_no_reinit"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const tx = await factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
        } catch { return false; }
      });
      const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const deployedAddress = parsed?.args[0];

      const PoPPayoutsV2 = await hre.ethers.getContractAt("PoPPayoutsV2", deployedAddress);

      // Try to re-initialize as random user
      await expect(PoPPayoutsV2.connect(randomUser).initialize(
        randomUser.address,
        randomUser.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("contract already initialized");

      // Try to re-initialize as owner
      await expect(PoPPayoutsV2.connect(owner).initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("contract already initialized");
    });

    // === MEDIUM VALUE TESTS ===

    it("multiple sequential deployments should all work correctly", async function () {
      const { supplyOwner, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const deployedAddresses: string[] = [];

      // Deploy 3 contracts with different salts
      for (let i = 0; i < 3; i++) {
        const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`test_salt_sequential_${i}`));

        const tx = await factory.deployAndInitialize(
          salt,
          owner.address,
          supplyOwner.address,
          HemiContract,
          INITIAL_SUPPLY,
          YEARLY_TOKEN_INFLATION,
          POP_INFLATION_ALLOCATION,
          now,
          INITIAL_REWARD
        );

        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PoPPayoutsV2Deployed";
          } catch { return false; }
        });
        const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
        deployedAddresses.push(parsed?.args[0]);
      }

      // All addresses should be different
      expect(deployedAddresses[0]).to.not.equal(deployedAddresses[1]);
      expect(deployedAddresses[1]).to.not.equal(deployedAddresses[2]);
      expect(deployedAddresses[0]).to.not.equal(deployedAddresses[2]);

      // All contracts should be functional
      for (const addr of deployedAddresses) {
        const contract = await hre.ethers.getContractAt("PoPPayoutsV2", addr);
        expect(await contract.owner()).to.equal(owner.address);
        expect(await contract.supplyOwner()).to.equal(supplyOwner.address);
      }
    });

    it("should revert if firstRoundRewards is zero", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_zero_rewards"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        0 // zero firstRoundRewards
      )).to.be.revertedWith("first round rewards cannot be zero");
    });

    it("should revert if popInflationAllocation exceeds inflation", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_pop_exceeds"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // popInflationAllocation (400) > inflationYearly (300) should fail
      // Both values are <= 500 (MAX_POP_INFLATION_ALLOCATION) to pass the first check
      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        300, // 3% inflation
        400, // 4% PoP allocation - exceeds inflation but still <= 500 max
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("PoP inflation must be less than or equal to initial inflation");
    });

    it("should revert if supplyTimestamp is in the future", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const futureTimestamp = now + 86400; // 1 day in future
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_future_timestamp"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        futureTimestamp,
        INITIAL_REWARD
      )).to.be.revertedWith("supply timestamp must be in the past");
    });

    it("computeAddress should be idempotent (multiple calls return same result)", async function () {
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_idempotent"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      const address1 = await factory.computeAddress(salt);
      const address2 = await factory.computeAddress(salt);
      const address3 = await factory.computeAddress(salt);

      expect(address1).to.equal(address2);
      expect(address2).to.equal(address3);
    });

    // === LOWER VALUE EDGE CASE TESTS ===

    it("should deploy successfully at exactly ERC20_MAX_SUPPLY boundary", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_max_supply"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // ERC20_MAX_SUPPLY = 1e20 * 1e18 = 1e38
      const maxSupply = hre.ethers.parseUnits("1", 38);

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        maxSupply,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      )).to.emit(factory, "PoPPayoutsV2Deployed");
    });

    it("should deploy successfully at exactly max inflation boundary (700 BPS)", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_max_inflation"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // MAX_YEARLY_TOKEN_INFLATION = 700 (7%)
      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        700, // max inflation
        500, // max PoP allocation
        now,
        INITIAL_REWARD
      )).to.emit(factory, "PoPPayoutsV2Deployed");
    });

    it("should revert if inflation exceeds max (700 BPS)", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_exceed_inflation"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        701, // exceeds max
        500,
        now,
        INITIAL_REWARD
      )).to.be.revertedWith("initial inflation is too high");
    });

    it("should deploy successfully with minimum valid supply (ERC20_MIN_SUPPLY)", async function () {
      const { owner, supplyOwner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();
      const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_salt_min_supply"));

      const FactoryContract = await hre.ethers.getContractFactory("PoPPayoutsV2Factory");
      const factory = await FactoryContract.deploy();

      // ERC20_MIN_SUPPLY = 1e24
      const minSupply = hre.ethers.parseUnits("1", 24);
      // For minimum supply, we need a proportionally smaller firstRoundRewards
      // Max reward is constrained by inflation, so use a very small value
      const smallReward = hre.ethers.parseUnits("1", 15); // 0.001 tokens

      await expect(factory.deployAndInitialize(
        salt,
        owner.address,
        supplyOwner.address,
        HemiContract,
        minSupply,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        smallReward
      )).to.emit(factory, "PoPPayoutsV2Deployed");
    });
  });

  describe("Circulating Supply Calculation", function () {
    it("Calculating supply for timestamp before supply timestamp should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.calculateCirculatingSupply(
        supplyTimestamp - 1
      )).to.be.revertedWith("time cannot be below the supply timestamp");
    });

    it("Calculating supply for timestamp above current timestamp should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      await expect(PoPPayoutsV2Contract.calculateCirculatingSupply(
        now + 1
      )).to.be.revertedWith("time cannot be in the future");
    })

    it("Calculating supply for current timestamp should be correct", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      expect(await PoPPayoutsV2Contract.calculateCirculatingSupply(now)).to.equal(INITIAL_SUPPLY);
    })

    it("Calculating supply for right before and after first emissions period should be correct", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      await time.increase(MINTAGE_PERIOD + 1);

      const emissions = (INITIAL_SUPPLY * BigInt(YEARLY_TOKEN_INFLATION) * BigInt(MINTAGE_PERIOD) * BigInt(100)) / 
      (BigInt((36525 * 86400)) * BPS);

      const month1Supply = INITIAL_SUPPLY + emissions;

      expect(await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + MINTAGE_PERIOD - 1)).to.equal(INITIAL_SUPPLY);
      expect(await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + MINTAGE_PERIOD)).to.equal(month1Supply);
      expect(await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + MINTAGE_PERIOD + 1)).to.equal(month1Supply);
    })

    it("Calculating supply for right before and after all emissions periods for 100 years should be correct", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // The optimized calculateCirculatingSupply function is slightly different from the regular iterative calculation.
      // This error should be small, not exceeding 0.00000000000102 HEMI after 100 years
      const maximumError = 1020000;

      const now = await time.latest();

      var supply = INITIAL_SUPPLY;
      for (let month = 1; month < 100 * 12; month++) {
        await time.increase(MINTAGE_PERIOD);

        const emissions = (supply * BigInt(YEARLY_TOKEN_INFLATION) * BigInt(MINTAGE_PERIOD) * BigInt(100)) / 
        (BigInt((36525 * 86400)) * BPS);
        var pastSupply = supply;
        supply = supply + emissions;

        const pastSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month) - 1);
        const currentSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month));

        expect(Math.abs(Number(pastSupply - pastSupplyCalc))).to.be.lt(maximumError)
        expect(Math.abs(Number(supply - currentSupplyCalc))).to.be.lt(maximumError)
      }
    })

    it("Calculating supply before and after a supply base update should be correct", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // This test calculates the supply based on original parameters up to 6 months, then changes the supply timestamp to be
      // 5 months in and ensures that the updated new calculation for month 6 is correct.

      // Mine 6 months worth of blocks
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(86400 * 30 * 6).toString(16)]);

      const maximumError = 1020000;

      const now = await time.latest();

      var supply = INITIAL_SUPPLY;
      var month5Supply = 0n;
      for (let month = 1; month <= 6; month++) {
        const emissions = (supply * BigInt(YEARLY_TOKEN_INFLATION) * BigInt(MINTAGE_PERIOD) * BigInt(100)) / 
        (BigInt((36525 * 86400)) * BPS);
        var pastSupply = supply;
        supply = supply + emissions;

        const pastSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month) - 1);
        const currentSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month));

        expect(Math.abs(Number(pastSupply - pastSupplyCalc))).to.be.lt(maximumError)
        expect(Math.abs(Number(supply - currentSupplyCalc))).to.be.lt(maximumError)

        if (month == 5) {
          month5Supply = currentSupplyCalc;
        }
      }

      // Now set a lower emissions schedule (600 bps) starting at month 5, with the baseSupply equaling the correct calculation up
      // through month 5
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         month5Supply, // higher
         600, // lower 
         POP_INFLATION_ALLOCATION, // no change 
         supplyTimestamp + (86400 * 30 * 5) // higher
      )).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(hre.ethers.parseUnits("10000000000", 18), month5Supply)
        .to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION, 600)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp, supplyTimestamp + (86400 * 30 * 5));

      var supply = month5Supply;
      for (let month = 6; month < 100; month++) {
        await time.increase(MINTAGE_PERIOD);

        const emissions = (supply * BigInt(600) * BigInt(MINTAGE_PERIOD) * BigInt(100)) / 
        (BigInt((36525 * 86400)) * BPS);
        var pastSupply = supply;
        supply = supply + emissions;

        const pastSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month) - 1);
        const currentSupplyCalc = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + (MINTAGE_PERIOD * month));

        expect(Math.abs(Number(pastSupply - pastSupplyCalc))).to.be.lt(maximumError)
        expect(Math.abs(Number(supply - currentSupplyCalc))).to.be.lt(maximumError)
      }
    })

    it("Fast (implementation) versus slow (exact) supply calculation should be similar", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      const RefSupplyCalculatorFactory = await hre.ethers.getContractFactory("RefSupplyCalculator");
      const RefSupplyCalculatorContract = await RefSupplyCalculatorFactory.deploy(
          supplyTimestamp,
          INITIAL_SUPPLY,
          YEARLY_TOKEN_INFLATION
      );

      await time.increase(86400 * 365 * 101); // Increase to 101 years to allow all circulating supply calls

      const m0ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(now);
      const m0fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(now);
      expect(Math.abs(Number(m0ref - m0fast))).to.be.lt(1000);

      const m1Time = now + (86400 * 365.25 / 12);
      const m1ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m1Time);
      const m1fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m1Time);
      expect(Math.abs(Number(m1ref - m1fast))).to.be.lt(1000);

      const m2Time = now + 2 * (86400 * 365.25 / 12);
      const m2ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m2Time);
      const m2fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m2Time);
      expect(Math.abs(Number(m2ref - m2fast))).to.be.lt(1000);

      const m3Time = now + 3 * (86400 * 365.25 / 12);
      const m3ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m3Time);
      const m3fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m3Time);
      expect(Math.abs(Number(m3ref - m3fast))).to.be.lt(1000);

      const m6Time = now + 6 * (86400 * 365.25 / 12);
      const m6ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m6Time);
      const m6fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m6Time);
      expect(Math.abs(Number(m6ref - m6fast))).to.be.lt(1000);

      const m12Time = now + 12 * (86400 * 365.25 / 12);
      const m12ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m12Time);
      const m12fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m12Time);
      expect(Math.abs(Number(m12ref - m12fast))).to.be.lt(1000);

      const m24Time = now + 24 * (86400 * 365.25 / 12);
      const m24ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m24Time);
      const m24fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m24Time);
      expect(Math.abs(Number(m24ref - m24fast))).to.be.lt(1000);

      const m36Time = now + 36 * (86400 * 365.25 / 12);
      const m36ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m36Time);
      const m36fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m36Time);
      expect(Math.abs(Number(m36ref - m36fast))).to.be.lt(1000);

      const m48Time = now + 48 * (86400 * 365.25 / 12);
      const m48ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m48Time);
      const m48fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m48Time);
      expect(Math.abs(Number(m48ref - m48fast))).to.be.lt(1000);

      // 5 years
      const m60Time = now + 60 * (86400 * 365.25 / 12);
      const m60ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m60Time);
      const m60fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m60Time);
      expect(Math.abs(Number(m60ref - m60fast))).to.be.lt(1000);

      // 10 years
      const m120Time = now + 120 * (86400 * 365.25 / 12);
      const m120ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m120Time);
      const m120fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m120Time);
      expect(Math.abs(Number(m120ref - m120fast))).to.be.lt(1000);
      
      // 20 years
      const m240Time = now + 240 * (86400 * 365.25 / 12);
      const m240ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m240Time);
      const m240fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m240Time);
      expect(Math.abs(Number(m240ref - m240fast))).to.be.lt(1000);
      
      // 50 years
      const m600Time = now + 600 * (86400 * 365.25 / 12);
      const m600ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m600Time);
      const m600fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m600Time);
      expect(Math.abs(Number(m600ref - m600fast))).to.be.lt(20000); // Larger time = larger error; this is 0.00000000000002 tokens
      
      // 100 years
      const m1200Time = now + 1200 * (86400 * 365.25 / 12);
      const m1200ref = await RefSupplyCalculatorContract.calculateCirculatingSupplyExact(m1200Time);
      const m1200fast = await PoPPayoutsV2Contract.calculateCirculatingSupply(m1200Time);
      expect(Math.abs(Number(m1200ref - m1200fast))).to.be.lt(2000000); // Larger time = larger error; this is 0.000000000002 tokens
    });

    it("Calculating block timestamp for future block should fail", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const currentBlockNumber = await hre.ethers.provider.getBlockNumber();
      const futureBlockHeight = currentBlockNumber + 1000;

      await expect(PoPPayoutsV2Contract.calculateBlockTimestamp(futureBlockHeight))
        .to.be.revertedWith("cannot calculate height for future block");
    });

    it("should maintain circulating supply monotonically non-decreasing over time", async function () {
      const { PoPPayoutsV2Contract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      let previousSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp);

      // Test at various time points over simulated 10 years
      // Advance blockchain time to ensure we can query future timestamps
      const maxOffset = MINTAGE_PERIOD * 120; // 10 years
      await time.increase(maxOffset);

      const timePoints = [
        0, // at supplyTimestamp
        MINTAGE_PERIOD - 1, // just before first period
        MINTAGE_PERIOD, // at first period
        MINTAGE_PERIOD + 1, // just after first period
        MINTAGE_PERIOD * 6, // 6 months
        MINTAGE_PERIOD * 12, // 1 year
        MINTAGE_PERIOD * 24, // 2 years
        MINTAGE_PERIOD * 60, // 5 years
        MINTAGE_PERIOD * 120, // 10 years
      ];

      for (const offset of timePoints) {
        const currentSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + offset);

        expect(currentSupply).to.be.gte(previousSupply,
          `Supply at offset ${offset} (${currentSupply}) should be >= previous (${previousSupply})`);

        previousSupply = currentSupply;
      }
    });

    it("should maintain circulating supply non-decreasing across random time jumps", async function () {
      const { PoPPayoutsV2Contract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance blockchain time significantly to allow future timestamp queries
      const maxTotalOffset = MINTAGE_PERIOD * 100; // 100 months total
      await time.increase(maxTotalOffset);

      const currentBlockTime = await time.latest();

      let previousTimestamp = supplyTimestamp;
      let previousSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(previousTimestamp);

      // Random jumps across the available time range
      for (let i = 0; i < 50; i++) {
        // Random offset between 1 second and 2 months, but stay within bounds
        const maxJump = Math.min(MINTAGE_PERIOD * 2, currentBlockTime - previousTimestamp);
        if (maxJump <= 1) break; // No more room to jump

        const randomOffset = Math.floor(Math.random() * maxJump) + 1;
        const currentTimestamp = previousTimestamp + randomOffset;

        // Safety check - don't exceed current block time
        if (currentTimestamp > currentBlockTime) break;

        const currentSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

        expect(currentSupply).to.be.gte(previousSupply,
          `Supply at timestamp ${currentTimestamp} (${currentSupply}) should be >= previous at ${previousTimestamp} (${previousSupply})`);

        previousTimestamp = currentTimestamp;
        previousSupply = currentSupply;
      }

      // Verify we made at least some jumps
      expect(previousTimestamp).to.be.gt(supplyTimestamp);
    });
  });

  describe("Supply Updates", function () {
    it("Updating supply with caller that is not supply owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      const now = await time.latest();

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyInformation(
        hre.ethers.parseUnits("10000000001", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, now + 1)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION + 1, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION + 1, supplyTimestamp)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp + 1)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateSupplyInformation(
        hre.ethers.parseUnits("10000000001", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION + 1, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION + 1, supplyTimestamp)
      ).to.be.revertedWith("only the supply owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp + 1)
      ).to.be.revertedWith("only the supply owner can call this function");
    });

    it("Updating supply to lower value should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        hre.ethers.parseUnits("9999999999", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("supply base can only be increased");
    });

    it("Updating yearly inflation to a value greater than 7% should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, 701, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("inflation is too high");
    });

    it("Updating pop inflation allocation to a value greater than 5% should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, 501, supplyTimestamp)
      ).to.be.revertedWith("PoP inflation is too high");
    });

    it("Updating pop inflation allocation higher than yearly token inflation should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // First, lower the inflation so we can set PoP inflation > inflation without hitting PoP inflation limit first
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(INITIAL_SUPPLY, 300, 200, supplyTimestamp);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, 300, 301, supplyTimestamp)
      ).to.be.revertedWith("PoP inflation must be less than or equal to inflation");
    });

    it("Updating supply time to earlier timestamp should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp - 1)
      ).to.be.revertedWith("updated supply timestamp must be greater than or equal to current supply timestamp");
    });

    it("Updating supply time to future timestamp should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Mine one block so that time.latest() is accurate
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(1).toString(16)]);
      var rightNow = await time.latest();

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, rightNow + 2)
      ).to.be.revertedWith("updated supply timestamp cannot be in the future");
    });

    it("Updating supply base to exceed ERC20_MAX_SUPPLY should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // ERC20_MAX_SUPPLY = 1e20 * 1e18 = 1e38, so use a value slightly larger
      const tooLargeSupply = hre.ethers.parseUnits("100000000000000000001", 18); // (1e20 + 1) * 1e18

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        tooLargeSupply, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.be.revertedWith("updated supply too large");
    });

    it("Updating supply to higher value should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        hre.ethers.parseUnits("10000000001", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(INITIAL_SUPPLY, hre.ethers.parseUnits("10000000001", 18))
        
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("10000000001", 18));

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        hre.ethers.parseUnits("11000000000", 18), YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(hre.ethers.parseUnits("10000000001", 18), hre.ethers.parseUnits("11000000000", 18))
        
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("11000000000", 18));
    });

    it("Updating yearly inflation to lower value should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION - 1, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION, YEARLY_TOKEN_INFLATION - 1)
        
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 1);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION - 25, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 1, YEARLY_TOKEN_INFLATION - 25)
        
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 25);
    });

    it("Updating yearly inflation to lower value then higher again should succeed and emit event", async function () {
      // This is permitted to allow the owner to correct misconfigured inflation values;
      // the Hemi token contract itself can only have a decreasing inflation.
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION - 1, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION, YEARLY_TOKEN_INFLATION - 1)

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 1);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 1, YEARLY_TOKEN_INFLATION)
        
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION);
    });

    it("Updating pop inflation allocation to lower value should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION - 1, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION, POP_INFLATION_ALLOCATION - 1)
        
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 1);
    });

    it("Updating pop inflation allocation to lower value then higher again should succeed and emit event", async function () {
      // Updating the PoP inflation to be higher (still within the inflation bounds) is permitted.
      // For example governance could lower the PoP inflation allocation, and then increase it later in response to
      // increasing Bitcoin fees.
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION - 1, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION, POP_INFLATION_ALLOCATION - 1)
        
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 1);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp)
      ).to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION - 1, POP_INFLATION_ALLOCATION)
        
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION);
    });

    it("Updating supply time to later timestamp should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp + 1)
      ).to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp, supplyTimestamp + 1);
      
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 1);

      await time.increase(10000000);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, supplyTimestamp + 10000000)
      ).to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp + 1, supplyTimestamp + 10000000);
      
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 10000000);
    });

    it("Updating multiple supply values correctly should succeed and emit events", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await time.increase(58593781);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("11000000000", 18), // higher
         YEARLY_TOKEN_INFLATION - 25, // lower 
         POP_INFLATION_ALLOCATION - 20, // lower 
         supplyTimestamp + 58593781 // higher
      )).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(hre.ethers.parseUnits("10000000000", 18), hre.ethers.parseUnits("11000000000", 18))
        .to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION, YEARLY_TOKEN_INFLATION - 25)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION, POP_INFLATION_ALLOCATION - 20)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp, supplyTimestamp + 58593781);
      
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("11000000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 25);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 20);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 58593781);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("11000000000", 18), // Same, no event
         YEARLY_TOKEN_INFLATION - 30, // Lower
         POP_INFLATION_ALLOCATION - 25, // Lower 
         supplyTimestamp + 58593781 // Same, no event
      )).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 25, YEARLY_TOKEN_INFLATION - 30)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION - 20, POP_INFLATION_ALLOCATION - 25);

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("11000000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 30);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 25);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 58593781);

      await time.increase(68949438 - 58593781);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("12000000000", 18), // Higher
         YEARLY_TOKEN_INFLATION - 30, // Same, no event
         POP_INFLATION_ALLOCATION - 25, // Same, no event 
         supplyTimestamp + 68949438 // Higher
      )).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(hre.ethers.parseUnits("11000000000", 18), hre.ethers.parseUnits("12000000000", 18))
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp + 58593781, supplyTimestamp + 68949438);

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("12000000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 30);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 25);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 68949438);

      await time.increase(69949438 - 68949438);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("12000000000", 18), // Same, no event
         YEARLY_TOKEN_INFLATION - 25, // Higher
         POP_INFLATION_ALLOCATION - 25, // Same, no event
         supplyTimestamp + 69949438 // Higher
      )).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 30, YEARLY_TOKEN_INFLATION - 25)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp + 68949438, supplyTimestamp + 69949438);

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("12000000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 25);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 25);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 69949438);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("13500000000", 18), // Higher
         YEARLY_TOKEN_INFLATION - 28, // Lower
         POP_INFLATION_ALLOCATION - 29, // Lower
         supplyTimestamp + 69949438 // Same, no event
      )).to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated").withArgs(hre.ethers.parseUnits("12000000000", 18), hre.ethers.parseUnits("13500000000", 18))
        .to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 25, YEARLY_TOKEN_INFLATION - 28)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION - 25, POP_INFLATION_ALLOCATION - 29);
 
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("13500000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 28);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 29);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 69949438);

      await time.increase(70435678 - 69949438);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
         hre.ethers.parseUnits("13500000000", 18), // Same, no event
         YEARLY_TOKEN_INFLATION - 27, // Higher
         POP_INFLATION_ALLOCATION - 24, // Higher
         supplyTimestamp + 70435678 // Higher
      )).to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated").withArgs(YEARLY_TOKEN_INFLATION - 28, YEARLY_TOKEN_INFLATION - 27)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated").withArgs(POP_INFLATION_ALLOCATION - 29, POP_INFLATION_ALLOCATION - 24)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated").withArgs(supplyTimestamp + 69949438, supplyTimestamp + 70435678);
 
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(hre.ethers.parseUnits("13500000000", 18));
      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 27);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(POP_INFLATION_ALLOCATION - 24);
      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(supplyTimestamp + 70435678);
    });

    it("should correctly update supply at exact mintage period boundary", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance exactly one mintage period (30 days)
      const oneMintagePeriod = MINTAGE_PERIOD;
      await time.increase(oneMintagePeriod);

      const currentTimestamp = await time.latest();
      const newSupplyTimestamp = supplyTimestamp + oneMintagePeriod;

      // Calculate what supply should be after exactly one mintage period
      const supplyBefore = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

      // Update supply timestamp to exactly one mintage period later
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        newSupplyTimestamp
      );

      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(newSupplyTimestamp);

      // Calculate supply after the update - should now use new timestamp as base
      const supplyAfter = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

      // Supply calculation should change because timestamp changed
      // With later timestamp, fewer periods have elapsed, so supply should be lower
      expect(supplyAfter).to.be.lte(supplyBefore);
    });

    it("should handle rapid consecutive supply updates correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance time a bit
      await time.increase(1000);

      const initialSupply = await PoPPayoutsV2Contract.supplyBase();
      const timestamp1 = await time.latest();

      // First update - increase supply
      const newSupply1 = initialSupply + BigInt(1000000);
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupply1,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        timestamp1
      );

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(newSupply1);

      // Advance one second
      await time.increase(1);
      const timestamp2 = await time.latest();

      // Second update - increase supply again
      const newSupply2 = newSupply1 + BigInt(1000000);
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupply2,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        timestamp2
      );

      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(newSupply2);

      // Advance one second
      await time.increase(1);
      const timestamp3 = await time.latest();

      // Third update - decrease inflation
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupply2,
        YEARLY_TOKEN_INFLATION - 100, // Reduce by 1%
        POP_INFLATION_ALLOCATION,
        timestamp3
      );

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(YEARLY_TOKEN_INFLATION - 100);
    });

    it("should correctly apply supply update immediately before a payout round", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Do first payout to establish baseline (first round uses firstRoundRewards)
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      // Advance to next keystone for second payout
      await time.increase(KEYSTONE_FREQUENCY * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

      currentBlock = await hre.ethers.provider.getBlockNumber();
      keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const currentTimestamp = await time.latest();

      // Get the maximum reward pool before supply update
      const maxRewardBefore = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);

      // Update supply to a higher value right before payout (keep original timestamp to avoid issues)
      const newSupplyBase = INITIAL_SUPPLY * 2n;

      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp // Keep original timestamp
      );

      // Get the maximum reward pool after supply update
      const maxRewardAfter = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);

      // Maximum reward pool should be approximately 2x with doubled supply
      // Allow 1% tolerance for any rounding in the calculation
      const tolerance = maxRewardBefore / 100n;
      expect(maxRewardAfter).to.be.gte(maxRewardBefore * 2n - tolerance);
      expect(maxRewardAfter).to.be.lte(maxRewardBefore * 2n + tolerance);

      // Execute payout - should use new supply parameters
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const rewardPool = parsed?.args[1];

      // Reward should be positive and within the new maximum
      expect(rewardPool).to.be.gt(0n);
      expect(rewardPool).to.be.lte(maxRewardAfter);
    });

    it("should handle supply update with maximum allowed inflation values", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      await time.increase(100);
      const currentTimestamp = await time.latest();

      // Update to maximum allowed values
      const MAX_SUPPLY_INFLATION_YEARLY = 700n; // 7%
      const MAX_POP_INFLATION_ALLOCATION = 500n; // 5%

      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        MAX_SUPPLY_INFLATION_YEARLY,
        MAX_POP_INFLATION_ALLOCATION,
        currentTimestamp
      );

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(MAX_SUPPLY_INFLATION_YEARLY);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(MAX_POP_INFLATION_ALLOCATION);
    });

    it("should handle supply update with zero inflation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await time.increase(100);
      const currentTimestamp = await time.latest();

      // Set both inflation values to zero
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        0n, // Zero yearly inflation
        0n, // Zero PoP allocation
        currentTimestamp
      );

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(0n);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(0n);

      // Advance time significantly
      await time.increase(365 * 24 * 60 * 60); // 1 year

      // Circulating supply should still equal base supply (no inflation)
      const futureTimestamp = await time.latest();
      const circulatingSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(futureTimestamp);

      // With zero inflation, circulating supply should equal base supply
      expect(circulatingSupply).to.equal(INITIAL_SUPPLY);
    });

    it("should handle supply update with PoP allocation equal to yearly inflation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      await time.increase(100);
      const currentTimestamp = await time.latest();

      // Set PoP allocation equal to yearly inflation (edge case: all inflation goes to PoP)
      const inflationValue = 300n; // 3%

      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        inflationValue,
        inflationValue, // Equal to yearly
        currentTimestamp
      );

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(inflationValue);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(inflationValue);
    });

    it("should correctly update erc20SupplyCalculationMultiplicationFactor when supply changes", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      const initialFactor = await PoPPayoutsV2Contract.erc20SupplyCalculationMultiplicationFactor();

      await time.increase(100);
      const currentTimestamp = await time.latest();

      // Update to a different supply base
      const newSupplyBase = INITIAL_SUPPLY * 3n;
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        currentTimestamp
      );

      const newFactor = await PoPPayoutsV2Contract.erc20SupplyCalculationMultiplicationFactor();

      // Factor should have changed
      expect(newFactor).to.not.equal(initialFactor);

      // Factor should be ERC20_ROUNDING_ERROR_FACTOR * (supplyBase / ERC20_ROUNDING_ERROR_FACTOR)
      const ERC20_ROUNDING_ERROR_FACTOR = BigInt("1000000000000000000"); // 1e18
      const expectedFactor = ERC20_ROUNDING_ERROR_FACTOR * (newSupplyBase / ERC20_ROUNDING_ERROR_FACTOR);
      expect(newFactor).to.equal(expectedFactor);
    });

    it("should handle supply timestamp update to exact current block timestamp", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance time
      await time.increase(1000);

      // Get exact current timestamp
      const currentTimestamp = await time.latest();

      // Update with timestamp equal to current block timestamp (boundary condition)
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        currentTimestamp
      );

      expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(currentTimestamp);
    });

    it("should correctly handle supply update spanning multiple mintage periods", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance 3 mintage periods (90 days)
      const threeMintagePeriods = MINTAGE_PERIOD * 3;
      await time.increase(threeMintagePeriods);

      const currentTimestamp = await time.latest();

      // Get supply calculation before update
      const supplyBefore = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

      // Update timestamp to current time (resets the base)
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        currentTimestamp
      );

      // Get supply calculation after update
      const supplyAfter = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

      // After resetting timestamp to current, supply should equal base (0 periods elapsed)
      expect(supplyAfter).to.equal(INITIAL_SUPPLY);

      // Before reset, supply should have been higher due to inflation
      expect(supplyBefore).to.be.gt(supplyAfter);
    });

    it("should emit correct events for each changed parameter", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      await time.increase(100);
      const newTimestamp = await time.latest();

      const newSupplyBase = INITIAL_SUPPLY + BigInt(1000000);
      const newInflation = YEARLY_TOKEN_INFLATION - 100;
      const newPoPAllocation = POP_INFLATION_ALLOCATION - 50;

      // Update all parameters at once
      const tx = await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        newInflation,
        newPoPAllocation,
        newTimestamp
      );

      // Should emit all four events
      await expect(tx)
        .to.emit(PoPPayoutsV2Contract, "SupplyBaseUpdated")
        .withArgs(INITIAL_SUPPLY, newSupplyBase);

      await expect(tx)
        .to.emit(PoPPayoutsV2Contract, "SupplyInflationYearlyUpdated")
        .withArgs(YEARLY_TOKEN_INFLATION, newInflation);

      await expect(tx)
        .to.emit(PoPPayoutsV2Contract, "PoPInflationAllocationUpdated")
        .withArgs(POP_INFLATION_ALLOCATION, newPoPAllocation);

      await expect(tx)
        .to.emit(PoPPayoutsV2Contract, "SupplyTimestampUpdated");
    });

    it("should not emit events when parameters remain unchanged", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Call update with all same values (except timestamp must be >= current)
      const tx = await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp // Same timestamp
      );

      const receipt = await tx.wait();

      // Should not emit any update events
      const updateEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data });
          return parsed?.name.includes("Updated");
        } catch { return false; }
      });

      expect(updateEvents?.length).to.equal(0);
    });

    it("should correctly update maximum reward pool after reducing inflation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance time so we can calculate meaningful values
      await time.increase(100 * 12);

      const currentTimestamp = await time.latest();

      // Get maximum reward pool before reducing PoP allocation
      const maxRewardBefore = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);

      // Reduce PoP inflation allocation by half
      const reducedAllocation = Math.floor(POP_INFLATION_ALLOCATION / 2);
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        reducedAllocation,
        supplyTimestamp
      );

      // Get maximum reward pool after reducing PoP allocation
      const maxRewardAfter = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);

      // Maximum reward pool should be approximately halved
      // (It's exactly half because it's directly proportional to popInflationAllocation)
      expect(maxRewardAfter).to.be.lt(maxRewardBefore);

      // Verify the ratio is approximately 1:2
      const ratio = (maxRewardBefore * 100n) / maxRewardAfter;
      expect(ratio).to.be.gte(195n); // At least 1.95:1
      expect(ratio).to.be.lte(205n); // At most 2.05:1
    });
  });

  describe("Governance", function () {
    it("Initiating supply owner update from non-owner-address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).updateSupplyOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerInit(
        random2.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerInit(
        random2.address
      )).to.be.revertedWith("only the owner can call this function");
    });

    it("Initiating supply owner update to zero-address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        ZERO_ADDRESS
      )).to.be.revertedWith("new supply owner cannot be zero address");
    });

    it("Initiating supply owner update to current supply owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        supplyOwner.address
      )).to.be.revertedWith("new supply owner cannot be existing supply owner");
    });

    it("Initiating supply owner update by owner to valid address should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);
    });

    it("Initiating supply owner update by owner twice to different valid addresses should succeed and emit event", async function () {
      // Initiating an update to the supply owner twice in a row just replaces the first supply owner with the second supply owner 
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random2.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random2.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);
    });

    it("Finalizing supply owner update when no pending update exists should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // No pending supply owner update has been initiated
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      // Attempting to finalize should fail
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can not finalize supply owner update when no pending supply owner update is in progress");

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can not finalize supply owner update when no pending supply owner update is in progress");

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can not finalize supply owner update when no pending supply owner update is in progress");
    });

    it("Finalizing supply owner update by non-new-supply-owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Owner cannot finalize supply owner upgrade; must be the new supply owner itself
      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending supply owner");

      // Current supply owner cannot finalize supply owner upgrade; must be the new supply owner itself
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending supply owner");

      // Random address should not be able to finalize supply owner upgrade
      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending supply owner");
    });

    it("Finalizing supply owner update by new-supply-owner should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerFinalize())
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(supplyOwner.address, random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random1.address);
    });

    it("Canceling supply owner update when no supply owner update is in progress should fail regardless of caller", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(await zeroSigner).updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerCancel())
        .to.be.revertedWith("cannot cancel a supply owner update if none is pending");

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });

    it("Addresses other than owner and new-supply-owner should not be able to cancel supply owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Protocol needs to call protocolForceSupplyOwnerUpdate instead
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).updateSupplyOwnerCancel())
        .to.be.revertedWith("only owner or pending supply owner can cancel a supply owner update");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateSupplyOwnerCancel())
        .to.be.revertedWith("only owner or pending supply owner can cancel a supply owner update");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).updateSupplyOwnerCancel())
        .to.be.revertedWith("only owner or pending supply owner can cancel a supply owner update");

      await expect(PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerCancel())
        .to.be.revertedWith("only owner or pending supply owner can cancel a supply owner update");

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner);
    });

    it("Canceling supply owner update by new-supply-owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerCancel())
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCanceled").withArgs(random1.address, supplyOwner.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });

    it("Canceling supply owner update by owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerCancel())
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCanceled").withArgs(random1.address, supplyOwner.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });

    it("Protocol address should be able to force a supply owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(supplyOwner.address, random1.address);

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random1);
    });

    it("Protocol address forcing a supply owner upgrade should cancel a pending supply owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(
        random2.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateInit").withArgs(random2.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(supplyOwner.address, random1.address);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random1);
    });

    it("Protocol address should not be able to force a supply owner update to the zero address", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(ZERO_ADDRESS))
        .to.be.revertedWith("new supply owner cannot be zero address");

      // Didn't change
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner);
    });

    it("Forcing supply owner upgrade to the current supply owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(supplyOwner.address))
        .to.be.revertedWith("new supply owner cannot be existing supply owner");

      // Didn't change
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });

    it("Forcing supply owner upgrade from addresses other than the protocol address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).protocolForceSupplyOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(supplyOwner.address);
    });

    it("Initiating owner update from non-owner-address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).updateOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerInit(
        random2.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerInit(
        random1.address
      )).to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerInit(
        random2.address
      )).to.be.revertedWith("only the owner can call this function");
    });

    it("Initiating owner update to zero-address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        ZERO_ADDRESS
      )).to.be.revertedWith("new owner cannot be zero address");
    });

    it("Initiating owner update to current owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        owner.address
      )).to.be.revertedWith("new owner cannot be existing owner");
    });

    it("Initiating owner update by owner to valid address should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
    });

    it("Initiating owner update by owner twice to different valid addresses should succeed and emit event", async function () {
      // Initiating an update to the owner twice in a row just replaces the first pending owner with the second
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random2.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random2.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random2.address);
    });

    it("Finalizing owner update when no pending update exists should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // No pending owner update has been initiated
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      // Attempting to finalize should fail
      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerFinalize())
        .to.be.revertedWith("can not finalize owner update when no pending owner update is in progress");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateOwnerFinalize())
        .to.be.revertedWith("can not finalize owner update when no pending owner update is in progress");

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize())
        .to.be.revertedWith("can not finalize owner update when no pending owner update is in progress");
    });

    it("Finalizing owner update by non-new-owner should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Owner cannot finalize owner upgrade; must be the new owner itself
      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending owner");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending owner");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending owner");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).updateOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending owner");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateOwnerFinalize())
        .to.be.revertedWith("can only be called by the pending owner");

      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
    });

    it("Finalizing owner update by new-owner should succeed and emit event", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize())
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(owner.address, random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
    });

    it("Canceling owner update when no owner update is in progress should fail regardless of caller", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(await zeroSigner).updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerCancel())
        .to.be.revertedWith("cannot cancel an owner update if none is pending");

      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });

    it("Addresses other than owner and new-owner should not be able to cancel owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol needs to call protocolForceOwnerUpdate instead
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).updateOwnerCancel())
        .to.be.revertedWith("only owner or pending owner can cancel an owner update");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).updateOwnerCancel())
        .to.be.revertedWith("only owner or pending owner can cancel an owner update");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).updateOwnerCancel())
        .to.be.revertedWith("only owner or pending owner can cancel an owner update");

      await expect(PoPPayoutsV2Contract.connect(random2).updateOwnerCancel())
        .to.be.revertedWith("only owner or pending owner can cancel an owner update");

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner);
    });

    it("Canceling owner update by new-owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerCancel())
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCanceled").withArgs(random1.address, owner.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });

    it("Canceling owner update by existing owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerCancel())
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCanceled").withArgs(random1.address, owner.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });

    it("Protocol address should be able to force an owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(owner.address, random1.address);

      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1);
    });

    it("Protocol address forcing a owner upgrade should cancel a pending owner upgrade", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).updateOwnerInit(
        random2.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateInit").withArgs(random2.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random2.address);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(owner.address, random1.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1);
    });

    it("Protocol address should not be able to force an owner update to the zero address", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(ZERO_ADDRESS))
        .to.be.revertedWith("new owner cannot be zero address");

      // Didn't change
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner);
    });

    it("Forcing owner upgrade to the current owner should fail", async function () {
      const { PoPPayoutsV2Contract, owner } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(owner.address))
        .to.be.revertedWith("new owner cannot be existing owner");

      // Didn't change
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });

    it("Forcing owner upgrade from addresses other than the protocol address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      await expect(PoPPayoutsV2Contract.connect(owner).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).protocolForceOwnerUpdate(random1.address))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);
    });


    it("should clear pendingOwner when protocolForceOwnerUpdate is called after updateOwnerInit", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init owner update
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol force owner update to different address
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random2.address);

      // Pending owner should be cleared
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random2.address);
    });

    it("should clear pendingSupplyOwner when protocolForceSupplyOwnerUpdate is called after updateSupplyOwnerInit", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init supply owner update
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Protocol force supply owner update to different address
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(random2.address);

      // Pending supply owner should be cleared
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
    });

    it("should clear pendingOwner when protocolForceOwnerUpdate updates to same address as pending", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init owner update
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol force owner update to same address as pending
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random1.address);

      // Pending owner should be cleared (even though same address was set as owner)
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
    });
    it("should emit OwnerUpdateCanceled when protocolForceOwnerUpdate overrides pending transfer", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init owner update to random1
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol force owner update to random2 should emit both cancellation and completion events
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random2.address))
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCanceled").withArgs(random1.address, owner.address)
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(owner.address, random2.address);
    });
    it("should emit SupplyOwnerUpdateCanceled when protocolForceSupplyOwnerUpdate overrides pending transfer", async function () {
      const { PoPPayoutsV2Contract, owner, supplyOwner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init supply owner update to random1
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Protocol force supply owner update to random2 should emit both cancellation and completion events
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(random2.address))
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCanceled").withArgs(random1.address, supplyOwner.address)
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(supplyOwner.address, random2.address);
    });
    it("should NOT emit OwnerUpdateCanceled when protocolForceOwnerUpdate has no pending transfer", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // No pending owner update - pendingOwner should be zero address
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      // Protocol force owner update should NOT emit cancellation event (only completion)
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random1.address))
        .to.emit(PoPPayoutsV2Contract, "OwnerUpdateCompleted").withArgs(owner.address, random1.address)
        .to.not.emit(PoPPayoutsV2Contract, "OwnerUpdateCanceled");
    });
    it("should NOT emit SupplyOwnerUpdateCanceled when protocolForceSupplyOwnerUpdate has no pending transfer", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // No pending supply owner update - pendingSupplyOwner should be zero address
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      // Protocol force supply owner update should NOT emit cancellation event (only completion)
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(random1.address))
        .to.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCompleted").withArgs(supplyOwner.address, random1.address)
        .to.not.emit(PoPPayoutsV2Contract, "SupplyOwnerUpdateCanceled");
    });
  });

  describe("Withdrawals", function () {
    it("Withdrawing by the owner more HEMI than the contract controls should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18)
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(HemiContract, hre.ethers.parseUnits("100001", 18), random1))
        .to.be.revertedWithCustomError(HemiContract, "ERC20InsufficientBalance").withArgs(PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18), hre.ethers.parseUnits("100001", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));
    });

    it("Withdrawing by the protocol more HEMI than the contract controls should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18)
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100001", 18), random1))
        .to.be.revertedWithCustomError(HemiContract, "ERC20InsufficientBalance").withArgs(PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18), hre.ethers.parseUnits("100001", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));
    });

    it("Withdrawing from zero address token contract should revert", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        ZERO_ADDRESS,
        hre.ethers.parseUnits("100", 18),
        random1.address
      )).to.be.revertedWith("cannot withdraw funds from a zero address token contract");
    });

    it("Withdrawing to zero address destination should revert", async function () {
      const { PoPPayoutsV2Contract, owner, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        HemiContract,
        hre.ethers.parseUnits("100", 18),
        ZERO_ADDRESS
      )).to.be.revertedWith("cannot withdraw funds to a zero address destination");
    });

    it("Withdrawing zero amount should revert", async function () {
      const { PoPPayoutsV2Contract, owner, HemiContract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        HemiContract,
        0,
        random1.address
      )).to.be.revertedWith("cannot withdraw a zero amount of funds");
    });

    it("Protocol withdrawing from zero address token contract should revert", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
        ZERO_ADDRESS,
        hre.ethers.parseUnits("100", 18),
        random1.address
      )).to.be.revertedWith("cannot withdraw funds from a zero address token contract");
    });
    
    it("Protocol withdrawing to zero address destination should revert", async function () {
      const { PoPPayoutsV2Contract, HemiContract } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
        HemiContract,
        hre.ethers.parseUnits("100", 18),
        ZERO_ADDRESS
      )).to.be.revertedWith("cannot withdraw funds to a zero address destination");
    });

    it("Protocol withdrawing zero amount should revert", async function () {
      const { PoPPayoutsV2Contract, HemiContract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
        HemiContract,
        0,
        random1.address
      )).to.be.revertedWith("cannot withdraw a zero amount of funds");
    });

    it("Withdrawing HEMI by a non-permissioned address should revert due to access control (regardless of amount)", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      // Even with amount exceeding balance, the permission check happens first
      await expect(PoPPayoutsV2Contract.connect(random1).withdrawFunds(HemiContract, hre.ethers.parseUnits("100001", 18), random1))
        .to.be.revertedWith("only the owner can call this function");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);
    });

    it("Withdrawing valid amount of HEMI by a non-permissioned address should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      await expect(PoPPayoutsV2Contract.connect(random1).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random2))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), supplyOwner))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), hemiTokenOwner))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), initialMintReceiver))
        .to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random2))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), supplyOwner))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), hemiTokenOwner))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), initialMintReceiver))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);
    });

    it("Withdrawing HEMI by the protocol with the regular withdrawal function should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the owner can call this function");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);
    });

    it("Withdrawing HEMI by the owner with the protocol withdrawal function should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      await expect(PoPPayoutsV2Contract.connect(owner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);
    });

    it("Withdrawing valid amount of HEMI by the owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18)
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));

      // Withdrawal to owner
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(HemiContract, hre.ethers.parseUnits("10000", 18), owner))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(HemiContract, owner.address, hre.ethers.parseUnits("10000", 18));

      // Withdrawal to random address
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(HemiContract, hre.ethers.parseUnits("90000", 18), random1))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(HemiContract, random1.address, hre.ethers.parseUnits("90000", 18));

      expect(await HemiContract.balanceOf(owner)).to.equal(hre.ethers.parseUnits("10000", 18));

      expect(await HemiContract.balanceOf(random1)).to.equal(hre.ethers.parseUnits("90000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("0", 18));
    });

    it("Withdrawing valid amount of HEMI by the protocol should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      expect(await HemiContract.balanceOf(initialMintReceiver)).to.equal(INITIAL_SUPPLY);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18)
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));

      // Withdrawal to random addresses
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("7000", 18), random1))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(HemiContract, random1.address, hre.ethers.parseUnits("7000", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(HemiContract, hre.ethers.parseUnits("93000", 18), random2))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(HemiContract, random2.address, hre.ethers.parseUnits("93000", 18));

      expect(await HemiContract.balanceOf(random1)).to.equal(hre.ethers.parseUnits("7000", 18));

      expect(await HemiContract.balanceOf(random2)).to.equal(hre.ethers.parseUnits("93000", 18));

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("0", 18));
    });

    it("Withdrawing by the owner more Random ERC20 than the contract controls should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("10001", 18), random1))
        .to.be.revertedWithCustomError(RandomERC20Contract, "ERC20InsufficientBalance").withArgs(PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18), hre.ethers.parseUnits("10001", 18));
    });

    it("Withdrawing by the protocol more Random ERC20 than the contract controls should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("10001", 18), random1))
        .to.be.revertedWithCustomError(RandomERC20Contract, "ERC20InsufficientBalance").withArgs(PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18), hre.ethers.parseUnits("10001", 18));
    });

    it("Withdrawing Random ERC20 by a non-permissioned address should revert due to access control (regardless of amount)", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      // Even with amount exceeding balance, the permission check happens first
      await expect(PoPPayoutsV2Contract.connect(random1).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("10001", 18), random1))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");
    });

    it("Withdrawing valid amount of Random ERC20 by a non-permissioned address should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver  } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      await expect(PoPPayoutsV2Contract.connect(random1).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the owner can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), random2))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(supplyOwner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), supplyOwner))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(hemiTokenOwner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), hemiTokenOwner))
        .to.be.revertedWith("only the owner can call this function");
        
      await expect(PoPPayoutsV2Contract.connect(initialMintReceiver).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), initialMintReceiver))
        .to.be.revertedWith("only the owner can call this function");
    });
    
    it("Withdrawing Random ERC20 by the protocol with the regular withdrawal function should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver  } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the owner can call this function");

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));
    });

    it("Withdrawing Random ERC20 by the owner with the protocol withdrawal function should revert", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver  } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("0", 0));

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      await expect(PoPPayoutsV2Contract.connect(owner).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("100", 18), random1))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));
    });

    it("Withdrawing valid amount of Random ERC20 by the owner should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver  } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("10000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      // Withdrawal to owner
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("9500", 18), owner))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(RandomERC20Contract, owner.address, hre.ethers.parseUnits("9500", 18));

      // Withdrawal to random address
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("500", 18), random1))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(RandomERC20Contract, random1.address, hre.ethers.parseUnits("500", 18));

      expect(await RandomERC20Contract.balanceOf(owner)).to.equal(hre.ethers.parseUnits("9500", 18));

      expect(await RandomERC20Contract.balanceOf(random1)).to.equal(hre.ethers.parseUnits("500", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("0", 18));
    });

    it("Withdrawing valid amount of Random ERC20 by the protocol should succeed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, RandomERC20Contract, initialRandomTokenReceiver  } = await loadFixture(deployPoPPayoutsV2AndRandomTokenContracts);

      expect(await RandomERC20Contract.balanceOf(initialRandomTokenReceiver)).to.equal(INITIAL_RANDOM_TOKEN_SUPPLY);

      await expect(RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(
        PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18)
      )).to.emit(RandomERC20Contract, "Transfer").withArgs(initialRandomTokenReceiver.address, PoPPayoutsV2Contract, hre.ethers.parseUnits("100000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("100000", 18));

      // Withdrawal to random addresses
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("95000", 18), owner))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(RandomERC20Contract, owner.address, hre.ethers.parseUnits("95000", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("5000", 18), random1))
        .to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful").withArgs(RandomERC20Contract, random1.address, hre.ethers.parseUnits("5000", 18));

      expect(await RandomERC20Contract.balanceOf(owner)).to.equal(hre.ethers.parseUnits("95000", 18));

      expect(await RandomERC20Contract.balanceOf(random1)).to.equal(hre.ethers.parseUnits("5000", 18));

      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("0", 18));
    });

    it("Withdrawing from ERC20 that returns false on transfer should revert with SafeERC20FailedOperation", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a mock ERC20 that returns false on transfer
      const MockFailingERC20Factory = await hre.ethers.getContractFactory("MockFailingERC20");
      const MockFailingERC20Contract = await MockFailingERC20Factory.deploy(
        PoPPayoutsV2Contract, // Mint tokens directly to the payout contract
        hre.ethers.parseUnits("10000", 18)
      );

      expect(await MockFailingERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      const mockTokenAddress = await MockFailingERC20Contract.getAddress();

      // Attempt withdrawal - should revert with SafeERC20FailedOperation since transfer returns false
      // This is the correct behavior: safeTransfer reverts instead of silently failing
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        MockFailingERC20Contract,
        hre.ethers.parseUnits("100", 18),
        random1.address
      )).to.be.revertedWithCustomError(PoPPayoutsV2Contract, "SafeERC20FailedOperation").withArgs(mockTokenAddress);

      // Balance should remain unchanged since transfer reverted
      expect(await MockFailingERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));
    });

    it("Protocol withdrawing from ERC20 that returns false on transfer should revert with SafeERC20FailedOperation", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a mock ERC20 that returns false on transfer
      const MockFailingERC20Factory = await hre.ethers.getContractFactory("MockFailingERC20");
      const MockFailingERC20Contract = await MockFailingERC20Factory.deploy(
        PoPPayoutsV2Contract, // Mint tokens directly to the payout contract
        hre.ethers.parseUnits("50000", 18)
      );

      expect(await MockFailingERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("50000", 18));

      const mockTokenAddress = await MockFailingERC20Contract.getAddress();

      // Attempt withdrawal via protocol - should revert with SafeERC20FailedOperation since transfer returns false
      // This is the correct behavior: safeTransfer reverts instead of silently failing
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
        MockFailingERC20Contract,
        hre.ethers.parseUnits("1000", 18),
        random1.address
      )).to.be.revertedWithCustomError(PoPPayoutsV2Contract, "SafeERC20FailedOperation").withArgs(mockTokenAddress);

      // Balance should remain unchanged since transfer reverted
      expect(await MockFailingERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("50000", 18));
    });

    it("Sending ETH directly to contract should revert", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Attempt to send ETH directly to the contract
      await expect(random1.sendTransaction({
        to: PoPPayoutsV2Contract,
        value: hre.ethers.parseEther("1.0")
      })).to.be.revertedWith("ETH transfers not accepted");
    });

    it("Withdrawing ETH by the owner to zero address should revert", async function () {
      const { PoPPayoutsV2Contract, owner } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        hre.ethers.parseEther("1.0"),
        ZERO_ADDRESS
      )).to.be.revertedWith("cannot withdraw ETH to zero address");
    });

    it("Withdrawing zero ETH by the owner should revert", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        0,
        random1.address
      )).to.be.revertedWith("cannot withdraw zero ETH");
    });

    it("Withdrawing more ETH than contract balance should revert", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Contract has 0 ETH, try to withdraw 1 ETH
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        hre.ethers.parseEther("1.0"),
        random1.address
      )).to.be.revertedWith("insufficient ETH balance");
    });

    it("Withdrawing ETH by non-owner should revert", async function () {
      const { PoPPayoutsV2Contract, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(random1).withdrawETH(
        hre.ethers.parseEther("1.0"),
        random2.address
      )).to.be.revertedWith("only the owner can call this function");
    });

    it("Withdrawing ETH by owner should succeed when ETH is force-sent via selfdestruct", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a contract that can selfdestruct and send ETH
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("2.0") });

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Verify contract received the ETH
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseEther("2.0"));

      const random1BalanceBefore = await hre.ethers.provider.getBalance(random1.address);

      // Owner withdraws ETH
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        hre.ethers.parseEther("1.5"),
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "WithdrawETHSuccessful").withArgs(random1.address, hre.ethers.parseEther("1.5"));

      // Verify balances
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseEther("0.5"));
      expect(await hre.ethers.provider.getBalance(random1.address)).to.equal(random1BalanceBefore + hre.ethers.parseEther("1.5"));
    });

    it("Withdrawing ETH by owner to contract that rejects ETH should revert", async function () {
      const { PoPPayoutsV2Contract, owner } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a contract that rejects ETH (no receive/fallback)
      const ETHRejecterFactory = await hre.ethers.getContractFactory("ETHRejecter");
      const ethRejecter = await ETHRejecterFactory.deploy();

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("1.0") });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Try to withdraw ETH to the rejecter contract - should fail
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        hre.ethers.parseEther("0.5"),
        ethRejecter
      )).to.be.revertedWith("ETH transfer failed");
    });

    it("Protocol withdrawing ETH to zero address should revert", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        hre.ethers.parseEther("1.0"),
        ZERO_ADDRESS
      )).to.be.revertedWith("cannot withdraw ETH to zero address");
    });

    it("Protocol withdrawing zero ETH should revert", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        0,
        random1.address
      )).to.be.revertedWith("cannot withdraw zero ETH");
    });

    it("Protocol withdrawing more ETH than contract balance should revert", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        hre.ethers.parseEther("1.0"),
        random1.address
      )).to.be.revertedWith("insufficient ETH balance");
    });

    it("Protocol withdrawing ETH by non-protocol address should revert", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(PoPPayoutsV2Contract.connect(owner).protocolForceWithdrawETH(
        hre.ethers.parseEther("1.0"),
        random1.address
      )).to.be.revertedWith("only the protocol-controlled depositor account can call this function");
    });

    it("Protocol withdrawing ETH should succeed when ETH is force-sent via selfdestruct", async function () {
      const { PoPPayoutsV2Contract, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a contract that can selfdestruct and send ETH
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("3.0") });

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Verify contract received the ETH
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseEther("3.0"));

      const random1BalanceBefore = await hre.ethers.provider.getBalance(random1.address);

      // Protocol withdraws ETH
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        hre.ethers.parseEther("2.5"),
        random1.address
      )).to.emit(PoPPayoutsV2Contract, "WithdrawETHSuccessful").withArgs(random1.address, hre.ethers.parseEther("2.5"));

      // Verify balances
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseEther("0.5"));
      expect(await hre.ethers.provider.getBalance(random1.address)).to.equal(random1BalanceBefore + hre.ethers.parseEther("2.5"));
    });

    it("Protocol withdrawing ETH to contract that rejects ETH should revert", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a contract that rejects ETH (no receive/fallback)
      const ETHRejecterFactory = await hre.ethers.getContractFactory("ETHRejecter");
      const ethRejecter = await ETHRejecterFactory.deploy();

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("1.0") });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Try to withdraw ETH to the rejecter contract - should fail
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        hre.ethers.parseEther("0.5"),
        ethRejecter
      )).to.be.revertedWith("ETH transfer failed");
    });

    it("should reject direct ETH transfers to contract", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);
      const [sender] = await hre.ethers.getSigners();

      const contractAddress = await PoPPayoutsV2Contract.getAddress();

      // Attempt to send ETH directly to the contract
      await expect(
        sender.sendTransaction({
          to: contractAddress,
          value: hre.ethers.parseEther("1.0")
        })
      ).to.be.revertedWith("ETH transfers not accepted");
    });

    it("should reject ETH transfers with empty data", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);
      const [sender] = await hre.ethers.getSigners();

      const contractAddress = await PoPPayoutsV2Contract.getAddress();

      // Send ETH with empty data (triggers receive())
      await expect(
        sender.sendTransaction({
          to: contractAddress,
          value: hre.ethers.parseEther("0.001"),
          data: "0x"
        })
      ).to.be.revertedWith("ETH transfers not accepted");
    });
  });


  describe("PoP Payout Calculation", function () {
    it("Calling mintPoPRewards from non-protocol-address should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ];


      const heights: number[] = [
        0,
        0,
        2
      ];

      await expect(PoPPayoutsV2Contract.connect(owner).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(supplyOwner).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random1).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      await expect(PoPPayoutsV2Contract.connect(random2).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("only the protocol-controlled depositor account can call this function");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(0);
    });
    it("Calling mintPoPRewards with mismatched address and height array lengths should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ];


      const heights: number[] = [
        0,
        0,
        2
      ];

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("Minting PoP rewards requires the accounts and publication heights to be the same length");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(0);
    });
    it("Calling mintPoPRewards with a non-keystone height should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ];


      const heights: number[] = [
        0,
        0
      ];

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(26, addresses, heights))
        .to.be.revertedWith("PoP Payouts can only be performed for a keystone block height");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(0);
    });
    it("Calling mintPoPRewards with the same or older keystone than the last rewarded should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ];


      const heights: number[] = [
        0,
        0
      ];

      await time.increase((100 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        100, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(100, INITIAL_REWARD, 100000 * 2); // Score is 100000 * 2 as both publications were at best index (0)

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(hre.ethers.parseUnits("50", 18));
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(hre.ethers.parseUnits("50", 18));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(100, addresses, heights))
        .to.be.revertedWith("Cannot reward keystones out-of-order");

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(75, addresses, heights))
        .to.be.revertedWith("Cannot reward keystones out-of-order");
    });
    it("Calling mintPoPRewards with publications that do not include relative height 0 should fail", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ];

      // None of the heights are 0 - this should fail because at least one publication
      // must be at the earliest relative height (0)
      const heights: number[] = [
        1,
        2,
        3
      ];

      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, addresses, heights))
        .to.be.revertedWith("at least one of the publications must be at earliest relative height 0");

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(0);
    });
    it("Calling mintPoPRewards for a block at or above current height should fail", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = ["0x1111111111111111111111111111111111111111"];
      const heights: number[] = [0];

      // First, mine blocks and complete a valid round so the "out-of-order" check passes
      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      // Complete the first round at keystone 25
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      // Now get current block and try to reward a keystone at/above it
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      // Round up to get a keystone that is at or above current block
      const currentOrFutureKeystone = Math.ceil(currentBlock / 25) * 25;

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        currentOrFutureKeystone, addresses, heights
      )).to.be.revertedWith("Cannot reward a block at/above the current height");

      // Also try with a definitely future keystone
      const futureKeystone = currentOrFutureKeystone + 25;
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        futureKeystone, addresses, heights
      )).to.be.revertedWith("Cannot reward a block at/above the current height");
    });
    it("Publications with relative height >= MAXIMUM_BTC_PUBLICATION_DELAY should receive zero points", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Address at height 0 gets full points, addresses at heights >= 9 get zero points
      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111", // height 0 - gets 100000 points
        "0x2222222222222222222222222222222222222222", // height 9 - gets 0 points
        "0x3333333333333333333333333333333333333333", // height 10 - gets 0 points
        "0x4444444444444444444444444444444444444444", // height 100 - gets 0 points
      ];

      const heights: number[] = [0, 9, 10, 100];

      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Execute the payout - only address[0] should receive tokens
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, addresses, heights))
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted")
        .withArgs(25, INITIAL_REWARD, 100000); // Total score is only 100000 (just the first publication)

      // Only the first address (height 0) should receive the full reward
      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD);

      // Addresses with height >= 9 should receive nothing
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(0);
      expect(await HemiContract.balanceOf(addresses[3])).to.equal(0);
    });
    it("First round with zero addresses should not pay out any tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, [], []
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, 0);

      // No payouts occurred, balance should be unchanged
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(25)
      await expect(round0.totalPoPScore).to.equal(0)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);
    });
    it("First round with 1 address should pay out all tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
      ];
      const heights: number[] = [
        0
      ];

      await time.increase((50 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        50, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, INITIAL_REWARD, 100000);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(50)
      await expect(round0.totalPoPScore).to.equal(100000)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(hre.ethers.parseUnits("100", 18));
    });
    it("Zero-address recipients should be skipped gracefully without reverting", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);

      await time.increase((50 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      // Include a zero-address recipient along with valid recipients
      // All have optimal publication height (0) so they all earn points
      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        ZERO_ADDRESS,  // This should be skipped
        "0x3333333333333333333333333333333333333333",
      ];
      const heights: number[] = [0, 0, 0];

      // Should NOT revert - zero address is skipped gracefully
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        50, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      // Verify round completed with correct total score (all 3 counted)
      const round0 = await PoPPayoutsV2Contract.rounds(0);
      expect(round0.totalPoPScore).to.equal(BigInt(300000)); // 3 x 100,000 points

      // Valid recipients should receive their share (1/3 each of reward pool)
      const expectedPerRecipient = INITIAL_REWARD / 3n;
      expect(await HemiContract.balanceOf(addresses[0])).to.equal(expectedPerRecipient);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(expectedPerRecipient);

      // Zero address balance is not directly checkable, but contract should retain the skipped reward
      // Contract balance = initial - 2 payouts (the zero-address payout was skipped)
      const expectedContractBalance = initialBalance - (expectedPerRecipient * 2n);
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(expectedContractBalance);
    });
    it("Round with only zero-address recipients should complete without paying anyone", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);

      await time.increase((50 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      // All recipients are zero-address
      const addresses: string[] = [ZERO_ADDRESS, ZERO_ADDRESS];
      const heights: number[] = [0, 0];

      // Should NOT revert
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        50, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      // Round should complete with points counted but no payouts
      const round0 = await PoPPayoutsV2Contract.rounds(0);
      expect(round0.totalPoPScore).to.equal(BigInt(200000)); // 2 x 100,000 points
      expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      // Contract balance unchanged - all rewards skipped
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(initialBalance);
    });
    it("First round with 3 addresses at same rel height should pay out all tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ];
      const heights: number[] = [
        0,
        0,
        0
      ];

      await time.increase((10000 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(10000).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        10000, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(10000, INITIAL_REWARD, 300000);

      // Calculate the rounding error and expected payouts
      var totalPoints = 0;

      for (let i = 0; i < heights.length; i++) {
        totalPoints += publicationHeightScores[heights[i]];
      }

      var rewardPerPointMathAdj = ERC20_MATH_MULTIPLIER * INITIAL_REWARD / BigInt(totalPoints);

      var rewards: bigint[] = Array(3);
      var totalRewards: bigint = BigInt(0);
      for (let i = 0; i < addresses.length; i++) {
        rewards[i] = BigInt(rewardPerPointMathAdj) * BigInt(publicationHeightScores[heights[i]]) / ERC20_MATH_MULTIPLIER;
        totalRewards += rewards[i];
      }

      var undistributedAdjustment = INITIAL_REWARD - totalRewards;

      // Rounding on 1/3 math should be 1 wei error
      expect(undistributedAdjustment).to.equal(1);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD + undistributedAdjustment);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(10000)
      await expect(round0.totalPoPScore).to.equal(300000)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(rewards[0]);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(rewards[1]);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(rewards[2]);
    });
    it("First round with 3 addresses including duplicate at same rel height should pay out all tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x1111111111111111111111111111111111111111",
      ];
      const heights: number[] = [
        0,
        0,
        0
      ];

      await time.increase((10000 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(10000).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        10000, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(10000, INITIAL_REWARD, 300000);

      // Calculate the rounding error and expected payouts
      var totalPoints = 0;

      for (let i = 0; i < heights.length; i++) {
        totalPoints += publicationHeightScores[heights[i]];
      }

      var rewardPerPointMathAdj = ERC20_MATH_MULTIPLIER * INITIAL_REWARD / BigInt(totalPoints);

      var rewards: bigint[] = Array(3);
      var totalRewards: bigint = BigInt(0);
      for (let i = 0; i < addresses.length; i++) {
        rewards[i] = BigInt(rewardPerPointMathAdj) * BigInt(publicationHeightScores[heights[i]]) / ERC20_MATH_MULTIPLIER;
        totalRewards += rewards[i];
      }

      var undistributedAdjustment = INITIAL_REWARD - totalRewards;

      // Rounding on 100/3 math should be 1 wei error
      expect(undistributedAdjustment).to.equal(1);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD + undistributedAdjustment);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(10000)
      await expect(round0.totalPoPScore).to.equal(300000)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(rewards[0] + rewards[2]);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(rewards[1]);
    });
    it("First round with 16 addresses at same rel height should pay out all tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002",
        "0xf100000000000000000000000000000000000003",
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
        "0xf100000000000000000000000000000000000010",
      ];
      const heights: number[] = [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];

      await time.increase((250 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(250).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        250, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(250, INITIAL_REWARD, publicationHeightScores[0] * 16);

      // Calculate the rounding error and expected payouts
      var totalPoints = 0;

      for (let i = 0; i < heights.length; i++) {
        totalPoints += publicationHeightScores[heights[i]];
      }

      var rewardPerPointMathAdj = ERC20_MATH_MULTIPLIER * INITIAL_REWARD / BigInt(totalPoints);

      var rewards: bigint[] = Array(3);
      var totalRewards: bigint = BigInt(0);
      for (let i = 0; i < addresses.length; i++) {
        rewards[i] = BigInt(rewardPerPointMathAdj) * BigInt(publicationHeightScores[heights[i]]) / ERC20_MATH_MULTIPLIER;
        totalRewards += rewards[i];
      }

      var undistributedAdjustment = INITIAL_REWARD - totalRewards;

      // Rounding on 100/16 math should be no error
      expect(undistributedAdjustment).to.equal(0);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(250)
      await expect(round0.totalPoPScore).to.equal(publicationHeightScores[0] * 16)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      for (let i = 0; i < addresses.length; i++) {
        expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i]);
      }
    });
    it("First round with 16 addresses including multiple duplicates at same rel height should pay out all tokens and update state correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", // Duplicate x3
        "0xf100000000000000000000000000000000000003",
        "0xf10000000000000000000000000000000000000e", // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000002", // Duplicate x3
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf100000000000000000000000000000000000002", // Duplicate x3
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e", // Duplicate x2
        "0xf10000000000000000000000000000000000000f",
        "0xf100000000000000000000000000000000000010",
      ];
      const heights: number[] = [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];

      await time.increase((250 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(250).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        250, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(250, INITIAL_REWARD, publicationHeightScores[0] * 16);

      // Calculate the rounding error and expected payouts
      var totalPoints = 0;

      for (let i = 0; i < heights.length; i++) {
        totalPoints += publicationHeightScores[heights[i]];
      }

      var rewardPerPointMathAdj = ERC20_MATH_MULTIPLIER * INITIAL_REWARD / BigInt(totalPoints);

      var rewards: bigint[] = Array(3);
      var totalRewards: bigint = BigInt(0);
      for (let i = 0; i < addresses.length; i++) {
        rewards[i] = BigInt(rewardPerPointMathAdj) * BigInt(publicationHeightScores[heights[i]]) / ERC20_MATH_MULTIPLIER;
        totalRewards += rewards[i];
      }

      var undistributedAdjustment = INITIAL_REWARD - totalRewards;

      // Rounding on 100/16 math should be no error
      expect(undistributedAdjustment).to.equal(0);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD);

      const round0 = await PoPPayoutsV2Contract.rounds(0);
      await expect(round0.blockHeight).to.equal(250)
      await expect(round0.totalPoPScore).to.equal(publicationHeightScores[0] * 16)
      await expect(round0.rewardPool).to.equal(INITIAL_REWARD);

      for (let i = 0; i < addresses.length; i++) {
        if (addresses[i] == "0xf100000000000000000000000000000000000002") {
          expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i] * BigInt(3));
        } else if (addresses[i] == "0xf10000000000000000000000000000000000000e") {
          expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i] * BigInt(2));
        } else {
          expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i]);
        }
      }
    });
    it("Skipped round after first round should use 10x multiplier in weighted average for subsequent rounds", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
      ];
      const heights: number[] = [
        0
      ];

      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // First round should pay out initial reward
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD);

      const skippedRoundRewardPool = INITIAL_REWARD * BigInt(5); // got 20% target = 5x

      // Skipped second round, so third round is calculated using 5x multiplier on first round and 10x multiplier on second (skipped) round
      const thirdRoundRewardPool = ((INITIAL_REWARD * BigInt(5) * BigInt(rewardLookbackWeighting[1])) + (skippedRoundRewardPool * BigInt(10) * BigInt(rewardLookbackWeighting[0]))) / 
        (BigInt(rewardLookbackWeighting[0]) + BigInt(rewardLookbackWeighting[1]));


      await time.increase((50 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (75), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, skippedRoundRewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, thirdRoundRewardPool, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD + thirdRoundRewardPool);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - (INITIAL_REWARD + thirdRoundRewardPool));
    });
    it("Multiple skipped rounds after first round should each use 10x multiplier in weighted average calculation", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
      ];
      const heights: number[] = [
        0
      ];

      await time.increase((25 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // First round should pay out initial reward
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD);

      const skippedRound2RewardPool = INITIAL_REWARD * BigInt(5); // got 20% target = 5x
      const skippedRound3RewardPool = ((INITIAL_REWARD * BigInt(5) * BigInt(rewardLookbackWeighting[1])) + 
        (skippedRound2RewardPool * BigInt(10) * BigInt(rewardLookbackWeighting[0]))) / 
        (BigInt(rewardLookbackWeighting[0]) + BigInt(rewardLookbackWeighting[1]));

      // Skipped second round, so third round is calculated using 5x multiplier on first round and 10x multiplier on second (skipped) round
      var fourthRoundRewardPool = ((INITIAL_REWARD * BigInt(5) * BigInt(rewardLookbackWeighting[2])) + 
        (skippedRound2RewardPool * BigInt(10) * BigInt(rewardLookbackWeighting[1])) + 
        (skippedRound3RewardPool * BigInt(10) * BigInt(rewardLookbackWeighting[0]))) / 
        (BigInt(rewardLookbackWeighting[0]) + BigInt(rewardLookbackWeighting[1]) + BigInt(rewardLookbackWeighting[2]));

      if (fourthRoundRewardPool > MAXIMUM_INITIAL_REWARD) {
        // This is the maximum reward with our current inflation settings at the beginning
        fourthRoundRewardPool = MAXIMUM_INITIAL_REWARD;
      }

      await time.increase((75 * 12));
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(75).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (100), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, skippedRound2RewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, skippedRound3RewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(100, fourthRoundRewardPool, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD + fourthRoundRewardPool);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - (INITIAL_REWARD + fourthRoundRewardPool));
    });
    
    it("Multiple round payouts with only 1 optimal publication should increase payouts", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
      ];
      const heights: number[] = [
        0
      ];

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // First round should pay out initial reward
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD);

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Second round should pay out 5x initial reward (20% optimal targets)
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (50), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, INITIAL_REWARD * BigInt(5), publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD + INITIAL_REWARD * BigInt(5));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Third round should pay out a weighted blend of 5x initial (round 0) + 25x initial (5x5x round 0)
      const thirdRoundRewardPool = ((INITIAL_REWARD * BigInt(5) * BigInt(rewardLookbackWeighting[1])) + (INITIAL_REWARD * BigInt(25) * BigInt(rewardLookbackWeighting[0]))) / 
        (BigInt(rewardLookbackWeighting[0]) + BigInt(rewardLookbackWeighting[1]));

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (75), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, thirdRoundRewardPool, publicationHeightScores[0]);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(INITIAL_REWARD + INITIAL_REWARD * BigInt(5) + thirdRoundRewardPool);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - (INITIAL_REWARD + INITIAL_REWARD * BigInt(5) + thirdRoundRewardPool));
    });
    it("Multiple round payouts with only 4 optimal publications should increase payouts", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002",
        "0xf100000000000000000000000000000000000003",
        "0xf100000000000000000000000000000000000004",
      ];
      const heights: number[] = [
        0,
        0,
        0,
        0
      ];

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // First round should pay out initial reward
      const firstRoundRewardPool = INITIAL_REWARD;
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, firstRoundRewardPool, publicationHeightScores[0] * 4);

      expect(await HemiContract.balanceOf(addresses[0])).to.equal(firstRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(firstRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(firstRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[3])).to.equal(firstRoundRewardPool / BigInt(4));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Second round should pay out 1.25x initial reward (80% optimal targets; 5/4 multiplier)
      const secondRoundRewardPool = INITIAL_REWARD * BigInt(5) / BigInt(4);
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (50), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, secondRoundRewardPool, publicationHeightScores[0] * 4);


      expect(await HemiContract.balanceOf(addresses[0])).to.equal((firstRoundRewardPool / BigInt(4)) + secondRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[1])).to.equal((firstRoundRewardPool / BigInt(4)) + secondRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[2])).to.equal((firstRoundRewardPool / BigInt(4)) + secondRoundRewardPool / BigInt(4));
      expect(await HemiContract.balanceOf(addresses[3])).to.equal((firstRoundRewardPool / BigInt(4)) + secondRoundRewardPool / BigInt(4));

      // Third round reward pool: weighted blend using 1.25x (5/4) retargeting multiplier for 4 publications (80% of target)
      const thirdRoundRewardPool = (firstRoundRewardPool  * BigInt(5) * BigInt(rewardLookbackWeighting[1]) / BigInt(4) +
      secondRoundRewardPool * BigInt(5) * BigInt(rewardLookbackWeighting[0]) / BigInt(4)) /
      (BigInt(rewardLookbackWeighting[1]) + BigInt(rewardLookbackWeighting[0]));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (75), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, thirdRoundRewardPool, publicationHeightScores[0] * 4);

      const totalRewardsPerMiner = (firstRoundRewardPool + secondRoundRewardPool + thirdRoundRewardPool) / BigInt(4);
      expect(await HemiContract.balanceOf(addresses[0])).to.equal(totalRewardsPerMiner);
      expect(await HemiContract.balanceOf(addresses[1])).to.equal(totalRewardsPerMiner);
      expect(await HemiContract.balanceOf(addresses[2])).to.equal(totalRewardsPerMiner);
      expect(await HemiContract.balanceOf(addresses[3])).to.equal(totalRewardsPerMiner);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - (totalRewardsPerMiner * BigInt(4)));
    });
    it("100 round payouts with stable (5) optimal publications should not change payouts", async function () {
      // We expect that multiple rounds with the optimal number of publications (5) should not change rewards at all
      this.timeout(100000); // specifically for npx hardhat coverage this test can take awhile to run

      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003"  // Duplicate x2
      ];
      const heights: number[] = [
        0,
        0,
        0,
        0,
        0,
      ];

      var rounds = 100;

      for (let i = 0; i < rounds; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          ((i+1) * 25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(((i+1) * 25), INITIAL_REWARD, publicationHeightScores[0] * 5);
      }

      // Calculate the rounding error and expected payouts
      var totalPoints = 0;

      for (let i = 0; i < heights.length; i++) {
        totalPoints += publicationHeightScores[heights[i]];
      }

      var rewardPerPointMathAdj = ERC20_MATH_MULTIPLIER * INITIAL_REWARD / BigInt(totalPoints);

      var rewards: bigint[] = Array(5);
      var totalRewards: bigint = BigInt(0);
      for (let i = 0; i < addresses.length; i++) {
        rewards[i] = BigInt(rounds) * BigInt(rewardPerPointMathAdj) * BigInt(publicationHeightScores[heights[i]]) / ERC20_MATH_MULTIPLIER;
        totalRewards += rewards[i];
      }

      totalRewards = totalRewards;

      var undistributedAdjustment = INITIAL_REWARD * BigInt(rounds) - totalRewards;

      // Rounding on 100/5 math should be no error
      expect(undistributedAdjustment).to.equal(0);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - INITIAL_REWARD * BigInt(rounds));


      for (let i = 0; i < rounds; i++) {
        const round = await PoPPayoutsV2Contract.rounds(i);
        await expect(round.blockHeight).to.equal((i+1) * 25)
        await expect(round.totalPoPScore).to.equal(publicationHeightScores[0] * 5)
        await expect(round.rewardPool).to.equal(INITIAL_REWARD);
      }

      for (let i = 0; i < addresses.length; i++) {
        if (addresses[i] == "0xf100000000000000000000000000000000000003") {
          expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i] * BigInt(2));
        } else {
          expect(await HemiContract.balanceOf(addresses[i])).to.equal(rewards[i]);
        }
      }
    });
    it("3 skipped rounds after the first 2 rounds should be correctly computed", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const addresses: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003",
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
        "0xf100000000000000000000000000000000000010",
        "0xf100000000000000000000000000000000000011",
        "0xf100000000000000000000000000000000000012",
        "0xf100000000000000000000000000000000000013",
        "0xf100000000000000000000000000000000000014"
      ];
      const heights: number[] = [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];

      var roundScore = 0n;
      for (let i = 0; i < heights.length; i++) {
        roundScore += BigInt(publicationHeightScores[heights[i]]);
      }

      await time.increase((25 * 11));
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      // Mine two rounds with 20 publications to get rewards low
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, roundScore);

      const r1AdjustedPool = (INITIAL_REWARD * ((TARGET_SCORE * BPS) / BigInt(roundScore))) / BPS;

      const round2RewardPool = r1AdjustedPool;

      await time.increase((25 * 11));
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (50), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, round2RewardPool, roundScore);

      const r2AdjustedPool = (round2RewardPool * ((TARGET_SCORE * BPS) / BigInt(roundScore))) / BPS;

      const round3RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[1]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1]));

      const r3AdjustedPool = round3RewardPool * BigInt(10);

      // Calculate the skipped round scores and rewards
      var round4RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[2]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[1]) +
        r3AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2]));

      const r4AdjustedPool = round4RewardPool * BigInt(10);

      var round5RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[3]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[2]) +
        r3AdjustedPool * BigInt(rewardLookbackWeighting[1]) +
        r4AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3]));

      const r5AdjustedPool = round5RewardPool * BigInt(10);

      var round6RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[4]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[3]) +
        r3AdjustedPool * BigInt(rewardLookbackWeighting[2]) +
        r4AdjustedPool * BigInt(rewardLookbackWeighting[1]) +
        r5AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3]
           + rewardLookbackWeighting[4]));

      const keystonesToSkip = 3;
      const blocksToMine = (keystonesToSkip + 1) * 25;
      const timeDelta = (blocksToMine * 12);

      // Increase time as expected based on missed keystone progression so calculation of past round
      // timestamps doesn't underflow
      await time.increase(timeDelta);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (50 + (keystonesToSkip + 1) * 25), addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, round3RewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(100, round4RewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(125, round5RewardPool, 0)
        .to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs((50 + (keystonesToSkip + 1) * 25), round6RewardPool, roundScore);

      for (let i = 0; i < heights.length; i++) {
        expect(await HemiContract.balanceOf(addresses[i])).to.equal(INITIAL_REWARD / BigInt(heights.length) + round2RewardPool / BigInt(heights.length) + 
          round6RewardPool / BigInt(heights.length));
      }
    });
    it("22 round payouts with oscillating publications above and below target and a skipped round should be correctly calculated", async function () {
      // This test oscillates between payout round scores below and above the optimal target,
      // over a long enough period that some previous rounds roll out of the calculation window
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const totalRewards: bigint[] = [
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n
      ];

      const addresses1: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003"  // Duplicate x2
      ];
      const heights1: number[] = [
        0,
        0,
        0,
        0,
        0,
      ];

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // First round should pay out initial reward
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (25), addresses1, heights1
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, publicationHeightScores[0] * 5);

      totalRewards[0] += INITIAL_REWARD / BigInt(5);
      totalRewards[1] += INITIAL_REWARD / BigInt(5);
      totalRewards[2] += INITIAL_REWARD / BigInt(5);
      totalRewards[3] += INITIAL_REWARD / BigInt(5);
      totalRewards[4] += INITIAL_REWARD / BigInt(5);

      const addresses2: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003"  // Duplicate x2
      ];
      const heights2: number[] = [
        0,
        1,
        0,
        1,
        1,
      ];

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (50), addresses2, heights2
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(50, INITIAL_REWARD, publicationHeightScores[0] * 5);

      totalRewards[0] += INITIAL_REWARD / BigInt(5);
      totalRewards[1] += INITIAL_REWARD / BigInt(5);
      totalRewards[2] += INITIAL_REWARD / BigInt(5);
      totalRewards[3] += INITIAL_REWARD / BigInt(5);
      totalRewards[4] += INITIAL_REWARD / BigInt(5);

      const addresses3: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003"  // Duplicate x2
      ];
      const heights3: number[] = [
        0,
        5,
        2,
        1,
        3,
      ];

      const round3PoPScore = publicationHeightScores[heights3[0]] + publicationHeightScores[heights3[1]] +
       publicationHeightScores[heights3[2]] + publicationHeightScores[heights3[3]] + publicationHeightScores[heights3[4]];

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Third round should pay out the same reward (weights of 0 and 1 receive the same score)
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (75), addresses3, heights3
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(75, INITIAL_REWARD, round3PoPScore);

      totalRewards[0] += INITIAL_REWARD * BigInt(publicationHeightScores[heights3[0]]) / BigInt(round3PoPScore);
      totalRewards[1] += INITIAL_REWARD * BigInt(publicationHeightScores[heights3[1]]) / BigInt(round3PoPScore);
      totalRewards[2] += INITIAL_REWARD * BigInt(publicationHeightScores[heights3[2]]) / BigInt(round3PoPScore);
      totalRewards[3] += INITIAL_REWARD * BigInt(publicationHeightScores[heights3[3]]) / BigInt(round3PoPScore);
      totalRewards[4] += INITIAL_REWARD * BigInt(publicationHeightScores[heights3[4]]) / BigInt(round3PoPScore);

      const addresses4: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003"  // Duplicate x2
      ];
      const heights4: number[] = [
        0,
        1,
        2,
        3,
        2,
      ];

      const r1AdjustedPool = INITIAL_REWARD;
      const r2AdjustedPool = INITIAL_REWARD;
      const r3AdjustedPool = (INITIAL_REWARD * ((TARGET_SCORE * BPS) / BigInt(round3PoPScore))) / BPS;

      const round4PoPScore = publicationHeightScores[heights4[0]] + publicationHeightScores[heights4[1]] +
       publicationHeightScores[heights4[2]] + publicationHeightScores[heights4[3]] + publicationHeightScores[heights4[4]];

      const round4RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[2]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2]));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (100), addresses4, heights4
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(100, round4RewardPool, round4PoPScore);

      totalRewards[0] += round4RewardPool * BigInt(publicationHeightScores[heights4[0]]) / BigInt(round4PoPScore);
      totalRewards[1] += round4RewardPool * BigInt(publicationHeightScores[heights4[1]]) / BigInt(round4PoPScore);
      totalRewards[2] += round4RewardPool * BigInt(publicationHeightScores[heights4[2]]) / BigInt(round4PoPScore);
      totalRewards[3] += round4RewardPool * BigInt(publicationHeightScores[heights4[3]]) / BigInt(round4PoPScore);
      totalRewards[4] += round4RewardPool * BigInt(publicationHeightScores[heights4[4]]) / BigInt(round4PoPScore);

      const addresses5: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005"
      ];

      // Six publications this round
      const heights5: number[] = [
        0,
        0,
        0,
        0,
        0,
        0
      ];

      const r4AdjustedPool = (round4RewardPool * ((TARGET_SCORE * BPS) / BigInt(round4PoPScore))) / BPS;

      const round5PoPScore = publicationHeightScores[heights5[0]] + publicationHeightScores[heights5[1]] +
       publicationHeightScores[heights5[2]] + publicationHeightScores[heights5[3]] + publicationHeightScores[heights5[4]] +
       publicationHeightScores[heights5[5]];

      const round5RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[3]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3]));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Fifth round payout
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (125), addresses5, heights5
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(125, round5RewardPool, round5PoPScore);

      totalRewards[0] += round5RewardPool * BigInt(publicationHeightScores[heights5[0]]) / BigInt(round5PoPScore);
      totalRewards[1] += round5RewardPool * BigInt(publicationHeightScores[heights5[1]]) / BigInt(round5PoPScore);
      totalRewards[2] += round5RewardPool * BigInt(publicationHeightScores[heights5[2]]) / BigInt(round5PoPScore);
      totalRewards[3] += round5RewardPool * BigInt(publicationHeightScores[heights5[3]]) / BigInt(round5PoPScore);
      totalRewards[4] += round5RewardPool * BigInt(publicationHeightScores[heights5[4]]) / BigInt(round5PoPScore);
      totalRewards[5] += round5RewardPool * BigInt(publicationHeightScores[heights5[5]]) / BigInt(round5PoPScore);

      const addresses6: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005"
      ];

      // Six publications this round, one non-optimal still scores > 500K total points
      const heights6: number[] = [
        0,
        1,
        1,
        1,
        0,
        2
      ];

      const r5AdjustedPool = (round5RewardPool * ((TARGET_SCORE * BPS) / BigInt(round5PoPScore))) / BPS;

      const round6PoPScore = publicationHeightScores[heights6[0]] + publicationHeightScores[heights6[1]] +
       publicationHeightScores[heights6[2]] + publicationHeightScores[heights6[3]] + publicationHeightScores[heights6[4]] +
       publicationHeightScores[heights6[5]];

      const round6RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[4]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (150), addresses6, heights6
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(150, round6RewardPool, round6PoPScore);

      totalRewards[0] += round6RewardPool * BigInt(publicationHeightScores[heights6[0]]) / BigInt(round6PoPScore);
      totalRewards[1] += round6RewardPool * BigInt(publicationHeightScores[heights6[1]]) / BigInt(round6PoPScore);
      totalRewards[2] += round6RewardPool * BigInt(publicationHeightScores[heights6[2]]) / BigInt(round6PoPScore);
      totalRewards[3] += round6RewardPool * BigInt(publicationHeightScores[heights6[3]]) / BigInt(round6PoPScore);
      totalRewards[4] += round6RewardPool * BigInt(publicationHeightScores[heights6[4]]) / BigInt(round6PoPScore);
      totalRewards[5] += round6RewardPool * BigInt(publicationHeightScores[heights6[5]]) / BigInt(round6PoPScore);

      const addresses7: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005"
      ];

      // Six publications this round, one non-optimal still scores > 500K total points
      const heights7: number[] = [
        0,
        0,
        1,
        1,
        0,
        1
      ];

      const r6AdjustedPool = (round6RewardPool * ((TARGET_SCORE * BPS) / BigInt(round6PoPScore))) / BPS;

      const round7PoPScore = publicationHeightScores[heights7[0]] + publicationHeightScores[heights7[1]] +
       publicationHeightScores[heights7[2]] + publicationHeightScores[heights7[3]] + publicationHeightScores[heights7[4]] +
       publicationHeightScores[heights7[5]];

      const round7RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[5]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (175), addresses7, heights7
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(175, round7RewardPool, round7PoPScore);

      totalRewards[0] += round7RewardPool * BigInt(publicationHeightScores[heights7[0]]) / BigInt(round7PoPScore);
      totalRewards[1] += round7RewardPool * BigInt(publicationHeightScores[heights7[1]]) / BigInt(round7PoPScore);
      totalRewards[2] += round7RewardPool * BigInt(publicationHeightScores[heights7[2]]) / BigInt(round7PoPScore);
      totalRewards[3] += round7RewardPool * BigInt(publicationHeightScores[heights7[3]]) / BigInt(round7PoPScore);
      totalRewards[4] += round7RewardPool * BigInt(publicationHeightScores[heights7[4]]) / BigInt(round7PoPScore);
      totalRewards[5] += round7RewardPool * BigInt(publicationHeightScores[heights7[5]]) / BigInt(round7PoPScore);

      const addresses8: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007"
      ];

      // Eight publications this round, one non-optimal still scores > 700K total points
      const heights8: number[] = [
        0,
        0,
        1,
        1,
        0,
        1,
        0,
        2
      ];

      const r7AdjustedPool = (round7RewardPool * ((TARGET_SCORE * BPS) / BigInt(round7PoPScore))) / BPS;

      const round8PoPScore = publicationHeightScores[heights8[0]] + publicationHeightScores[heights8[1]] +
       publicationHeightScores[heights8[2]] + publicationHeightScores[heights8[3]] + publicationHeightScores[heights8[4]] +
       publicationHeightScores[heights8[5]] + publicationHeightScores[heights8[6]] + publicationHeightScores[heights8[7]];

      const round8RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[6]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (200), addresses8, heights8
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(200, round8RewardPool, round8PoPScore);

      totalRewards[0] += round8RewardPool * BigInt(publicationHeightScores[heights8[0]]) / BigInt(round8PoPScore);
      totalRewards[1] += round8RewardPool * BigInt(publicationHeightScores[heights8[1]]) / BigInt(round8PoPScore);
      totalRewards[2] += round8RewardPool * BigInt(publicationHeightScores[heights8[2]]) / BigInt(round8PoPScore);
      totalRewards[3] += round8RewardPool * BigInt(publicationHeightScores[heights8[3]]) / BigInt(round8PoPScore);
      totalRewards[4] += round8RewardPool * BigInt(publicationHeightScores[heights8[4]]) / BigInt(round8PoPScore);
      totalRewards[5] += round8RewardPool * BigInt(publicationHeightScores[heights8[5]]) / BigInt(round8PoPScore);
      totalRewards[6] += round8RewardPool * BigInt(publicationHeightScores[heights8[6]]) / BigInt(round8PoPScore);
      totalRewards[7] += round8RewardPool * BigInt(publicationHeightScores[heights8[7]]) / BigInt(round8PoPScore);

      const addresses9: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007"
      ];

      // Eight publications this round, two non-optimal still scores > 600K total points
      const heights9: number[] = [
        0,
        0,
        1,
        1,
        0,
        1,
        8,
        6
      ];

      const r8AdjustedPool = (round8RewardPool * ((TARGET_SCORE * BPS) / BigInt(round8PoPScore))) / BPS;

      const round9PoPScore = publicationHeightScores[heights9[0]] + publicationHeightScores[heights9[1]] +
       publicationHeightScores[heights9[2]] + publicationHeightScores[heights9[3]] + publicationHeightScores[heights9[4]] +
       publicationHeightScores[heights9[5]] + publicationHeightScores[heights9[6]] + publicationHeightScores[heights9[7]];

      const round9RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[7]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (225), addresses9, heights9
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(225, round9RewardPool, round9PoPScore);

      totalRewards[0] += round9RewardPool * BigInt(publicationHeightScores[heights9[0]]) / BigInt(round9PoPScore);
      totalRewards[1] += round9RewardPool * BigInt(publicationHeightScores[heights9[1]]) / BigInt(round9PoPScore);
      totalRewards[2] += round9RewardPool * BigInt(publicationHeightScores[heights9[2]]) / BigInt(round9PoPScore);
      totalRewards[3] += round9RewardPool * BigInt(publicationHeightScores[heights9[3]]) / BigInt(round9PoPScore);
      totalRewards[4] += round9RewardPool * BigInt(publicationHeightScores[heights9[4]]) / BigInt(round9PoPScore);
      totalRewards[5] += round9RewardPool * BigInt(publicationHeightScores[heights9[5]]) / BigInt(round9PoPScore);
      totalRewards[6] += round9RewardPool * BigInt(publicationHeightScores[heights9[6]]) / BigInt(round9PoPScore);
      totalRewards[7] += round9RewardPool * BigInt(publicationHeightScores[heights9[7]]) / BigInt(round9PoPScore);

      // 10 optimal publications
      const addresses10: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
      ];

      // Ten publications this round, all optimal (height 0 or 1), scores 1M total points
      const heights10: number[] = [
        0,
        0,
        1,
        1,
        0,
        1,
        0,
        0,
        1,
        1
      ];

      const r9AdjustedPool = (round9RewardPool * ((TARGET_SCORE * BPS) / BigInt(round9PoPScore))) / BPS;

      const round10PoPScore = publicationHeightScores[heights10[0]] + publicationHeightScores[heights10[1]] +
       publicationHeightScores[heights10[2]] + publicationHeightScores[heights10[3]] + publicationHeightScores[heights10[4]] +
       publicationHeightScores[heights10[5]] + publicationHeightScores[heights10[6]] + publicationHeightScores[heights10[7]] + 
       publicationHeightScores[heights10[8]] + publicationHeightScores[heights10[9]];

      const round10RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[8]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (250), addresses10, heights10
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(250, round10RewardPool, round10PoPScore);

      totalRewards[0] += round10RewardPool * BigInt(publicationHeightScores[heights10[0]]) / BigInt(round10PoPScore);
      totalRewards[1] += round10RewardPool * BigInt(publicationHeightScores[heights10[1]]) / BigInt(round10PoPScore);
      totalRewards[2] += round10RewardPool * BigInt(publicationHeightScores[heights10[2]]) / BigInt(round10PoPScore);
      totalRewards[3] += round10RewardPool * BigInt(publicationHeightScores[heights10[3]]) / BigInt(round10PoPScore);
      totalRewards[4] += round10RewardPool * BigInt(publicationHeightScores[heights10[4]]) / BigInt(round10PoPScore);
      totalRewards[5] += round10RewardPool * BigInt(publicationHeightScores[heights10[5]]) / BigInt(round10PoPScore);
      totalRewards[6] += round10RewardPool * BigInt(publicationHeightScores[heights10[6]]) / BigInt(round10PoPScore);
      totalRewards[7] += round10RewardPool * BigInt(publicationHeightScores[heights10[7]]) / BigInt(round10PoPScore);
      totalRewards[8] += round10RewardPool * BigInt(publicationHeightScores[heights10[8]]) / BigInt(round10PoPScore);
      totalRewards[9] += round10RewardPool * BigInt(publicationHeightScores[heights10[9]]) / BigInt(round10PoPScore);

      // 10 nearly optimal publications
      const addresses11: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
      ];

      // Ten publications this round, two non-optimal (height 2), scores > 900K total points
      const heights11: number[] = [
        0,
        0,
        1,
        2,
        0,
        1,
        0,
        2,
        1,
        1
      ];

      const r10AdjustedPool = (round10RewardPool * ((TARGET_SCORE * BPS) / BigInt(round10PoPScore))) / BPS;

      const round11PoPScore = publicationHeightScores[heights11[0]] + publicationHeightScores[heights11[1]] +
       publicationHeightScores[heights11[2]] + publicationHeightScores[heights11[3]] + publicationHeightScores[heights11[4]] +
       publicationHeightScores[heights11[5]] + publicationHeightScores[heights11[6]] + publicationHeightScores[heights11[7]] + 
       publicationHeightScores[heights11[8]] + publicationHeightScores[heights11[9]];

      const round11RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[9]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (275), addresses11, heights11
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(275, round11RewardPool, round11PoPScore);

      totalRewards[0] += round11RewardPool * BigInt(publicationHeightScores[heights11[0]]) / BigInt(round11PoPScore);
      totalRewards[1] += round11RewardPool * BigInt(publicationHeightScores[heights11[1]]) / BigInt(round11PoPScore);
      totalRewards[2] += round11RewardPool * BigInt(publicationHeightScores[heights11[2]]) / BigInt(round11PoPScore);
      totalRewards[3] += round11RewardPool * BigInt(publicationHeightScores[heights11[3]]) / BigInt(round11PoPScore);
      totalRewards[4] += round11RewardPool * BigInt(publicationHeightScores[heights11[4]]) / BigInt(round11PoPScore);
      totalRewards[5] += round11RewardPool * BigInt(publicationHeightScores[heights11[5]]) / BigInt(round11PoPScore);
      totalRewards[6] += round11RewardPool * BigInt(publicationHeightScores[heights11[6]]) / BigInt(round11PoPScore);
      totalRewards[7] += round11RewardPool * BigInt(publicationHeightScores[heights11[7]]) / BigInt(round11PoPScore);
      totalRewards[8] += round11RewardPool * BigInt(publicationHeightScores[heights11[8]]) / BigInt(round11PoPScore);
      totalRewards[9] += round11RewardPool * BigInt(publicationHeightScores[heights11[9]]) / BigInt(round11PoPScore);

      // Drop down to 4 optimal publications
      const addresses12: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004"
      ];

      const heights12: number[] = [
        0,
        0,
        1,
        0
      ];

      const r11AdjustedPool = (round11RewardPool * ((TARGET_SCORE * BPS) / BigInt(round11PoPScore))) / BPS;

      const round12PoPScore = publicationHeightScores[heights12[0]] + publicationHeightScores[heights12[1]] +
       publicationHeightScores[heights12[2]] + publicationHeightScores[heights12[3]];

      const round12RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[10]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (300), addresses12, heights12
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(300, round12RewardPool, round12PoPScore);

      totalRewards[0] += round12RewardPool * BigInt(publicationHeightScores[heights12[0]]) / BigInt(round12PoPScore);
      totalRewards[1] += round12RewardPool * BigInt(publicationHeightScores[heights12[1]]) / BigInt(round12PoPScore);
      totalRewards[2] += round12RewardPool * BigInt(publicationHeightScores[heights12[2]]) / BigInt(round12PoPScore);
      totalRewards[3] += round12RewardPool * BigInt(publicationHeightScores[heights12[3]]) / BigInt(round12PoPScore);

      // Stay at 4 optimal publications
      const addresses13: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003",
        "0xf100000000000000000000000000000000000004"
      ];

      const heights13: number[] = [
        0,
        0,
        1,
        0
      ];

      const r12AdjustedPool = (round12RewardPool * ((TARGET_SCORE * BPS) / BigInt(round12PoPScore))) / BPS;

      const round13PoPScore = publicationHeightScores[heights13[0]] + publicationHeightScores[heights13[1]] +
       publicationHeightScores[heights13[2]] + publicationHeightScores[heights13[3]];

      const round13RewardPool = (r1AdjustedPool * BigInt(rewardLookbackWeighting[11]) +
        r2AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (325), addresses13, heights13
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(325, round13RewardPool, round13PoPScore);

      totalRewards[0] += round13RewardPool * BigInt(publicationHeightScores[heights13[0]]) / BigInt(round13PoPScore);
      totalRewards[1] += round13RewardPool * BigInt(publicationHeightScores[heights13[1]]) / BigInt(round13PoPScore);
      totalRewards[2] += round13RewardPool * BigInt(publicationHeightScores[heights13[2]]) / BigInt(round13PoPScore);
      totalRewards[3] += round13RewardPool * BigInt(publicationHeightScores[heights13[3]]) / BigInt(round13PoPScore);

      // Drop to 2 optimal publications
      const addresses14: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
      ];

      const heights14: number[] = [
        0,
        0
      ];

      const r13AdjustedPool = (round13RewardPool * ((TARGET_SCORE * BPS) / BigInt(round13PoPScore))) / BPS;

      const round14PoPScore = publicationHeightScores[heights14[0]] + publicationHeightScores[heights14[1]];

      const round14RewardPool = (r2AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r3AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (350), addresses14, heights14
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(350, round14RewardPool, round14PoPScore);

      totalRewards[0] += round14RewardPool * BigInt(publicationHeightScores[heights14[0]]) / BigInt(round14PoPScore);
      totalRewards[1] += round14RewardPool * BigInt(publicationHeightScores[heights14[1]]) / BigInt(round14PoPScore);

      // Increase to 10 optimal publications
      const addresses15: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
      ];

      const heights15: number[] = [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];

      const r14AdjustedPool = (round14RewardPool * ((TARGET_SCORE * BPS) / BigInt(round14PoPScore))) / BPS;

      const round15PoPScore = publicationHeightScores[heights15[0]] + publicationHeightScores[heights15[1]] + publicationHeightScores[heights15[2]] +
        publicationHeightScores[heights15[3]] + publicationHeightScores[heights15[4]] + publicationHeightScores[heights15[5]] + 
        publicationHeightScores[heights15[6]] + publicationHeightScores[heights15[7]] + publicationHeightScores[heights15[8]] + 
        publicationHeightScores[heights15[9]];

      const round15RewardPool = (r3AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r4AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (375), addresses15, heights15
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(375, round15RewardPool, round15PoPScore);

      totalRewards[0] += round15RewardPool * BigInt(publicationHeightScores[heights15[0]]) / BigInt(round15PoPScore);
      totalRewards[1] += round15RewardPool * BigInt(publicationHeightScores[heights15[1]]) / BigInt(round15PoPScore);
      totalRewards[2] += round15RewardPool * BigInt(publicationHeightScores[heights15[2]]) / BigInt(round15PoPScore);
      totalRewards[3] += round15RewardPool * BigInt(publicationHeightScores[heights15[3]]) / BigInt(round15PoPScore);
      totalRewards[4] += round15RewardPool * BigInt(publicationHeightScores[heights15[4]]) / BigInt(round15PoPScore);
      totalRewards[5] += round15RewardPool * BigInt(publicationHeightScores[heights15[5]]) / BigInt(round15PoPScore);
      totalRewards[6] += round15RewardPool * BigInt(publicationHeightScores[heights15[6]]) / BigInt(round15PoPScore);
      totalRewards[7] += round15RewardPool * BigInt(publicationHeightScores[heights15[7]]) / BigInt(round15PoPScore);
      totalRewards[8] += round15RewardPool * BigInt(publicationHeightScores[heights15[8]]) / BigInt(round15PoPScore);
      totalRewards[9] += round15RewardPool * BigInt(publicationHeightScores[heights15[9]]) / BigInt(round15PoPScore);

      // 8 optimal publications
      const addresses16: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
      ];

      const heights16: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
      ];

      const r15AdjustedPool = (round15RewardPool * ((TARGET_SCORE * BPS) / BigInt(round15PoPScore))) / BPS;

      const round16PoPScore = publicationHeightScores[heights16[0]] + publicationHeightScores[heights16[1]] + publicationHeightScores[heights16[2]] +
        publicationHeightScores[heights16[3]] + publicationHeightScores[heights16[4]] + publicationHeightScores[heights16[5]] + 
        publicationHeightScores[heights16[6]] + publicationHeightScores[heights16[7]];

      const round16RewardPool = (r4AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r5AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (400), addresses16, heights16
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(400, round16RewardPool, round16PoPScore);

      totalRewards[0] += round16RewardPool * BigInt(publicationHeightScores[heights16[0]]) / BigInt(round16PoPScore);
      totalRewards[1] += round16RewardPool * BigInt(publicationHeightScores[heights16[1]]) / BigInt(round16PoPScore);
      totalRewards[2] += round16RewardPool * BigInt(publicationHeightScores[heights16[2]]) / BigInt(round16PoPScore);
      totalRewards[3] += round16RewardPool * BigInt(publicationHeightScores[heights16[3]]) / BigInt(round16PoPScore);
      totalRewards[4] += round16RewardPool * BigInt(publicationHeightScores[heights16[4]]) / BigInt(round16PoPScore);
      totalRewards[5] += round16RewardPool * BigInt(publicationHeightScores[heights16[5]]) / BigInt(round16PoPScore);
      totalRewards[6] += round16RewardPool * BigInt(publicationHeightScores[heights16[6]]) / BigInt(round16PoPScore);
      totalRewards[7] += round16RewardPool * BigInt(publicationHeightScores[heights16[7]]) / BigInt(round16PoPScore);

      // Skip round 17, but calculate the skipped reward pool
      const r16AdjustedPool = (round16RewardPool * ((TARGET_SCORE * BPS) / BigInt(round16PoPScore))) / BPS;

      const round17PoPScore = 0; // No publications; skipped
      const round17RewardPool = (r5AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r6AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      const r17AdjustedPool = round17RewardPool * BigInt(10); // Skipped round has 10x multiplier applied

      // 16 optimal publications (assumes massive spike from missed round encourages lots of publications)
      const addresses18: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
      ];

      const heights18: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0
      ];

      const round18PoPScore = publicationHeightScores[heights18[0]] + publicationHeightScores[heights18[1]] + publicationHeightScores[heights18[2]] +
        publicationHeightScores[heights18[3]] + publicationHeightScores[heights18[4]] + publicationHeightScores[heights18[5]] +
        publicationHeightScores[heights18[6]] + publicationHeightScores[heights18[7]] + publicationHeightScores[heights18[8]] +
        publicationHeightScores[heights18[9]] + publicationHeightScores[heights18[10]] + publicationHeightScores[heights18[11]] +
        publicationHeightScores[heights18[12]] + publicationHeightScores[heights18[13]] + publicationHeightScores[heights18[14]] +
        publicationHeightScores[heights18[15]];

      const round18RewardPool = (r6AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r7AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r17AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12 * 2);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25 * 2).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (450), addresses18, heights18
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(450, round18RewardPool, round18PoPScore);

      totalRewards[0] += round18RewardPool * BigInt(publicationHeightScores[heights18[0]]) / BigInt(round18PoPScore);
      totalRewards[1] += round18RewardPool * BigInt(publicationHeightScores[heights18[1]]) / BigInt(round18PoPScore);
      totalRewards[2] += round18RewardPool * BigInt(publicationHeightScores[heights18[2]]) / BigInt(round18PoPScore);
      totalRewards[3] += round18RewardPool * BigInt(publicationHeightScores[heights18[3]]) / BigInt(round18PoPScore);
      totalRewards[4] += round18RewardPool * BigInt(publicationHeightScores[heights18[4]]) / BigInt(round18PoPScore);
      totalRewards[5] += round18RewardPool * BigInt(publicationHeightScores[heights18[5]]) / BigInt(round18PoPScore);
      totalRewards[6] += round18RewardPool * BigInt(publicationHeightScores[heights18[6]]) / BigInt(round18PoPScore);
      totalRewards[7] += round18RewardPool * BigInt(publicationHeightScores[heights18[7]]) / BigInt(round18PoPScore);
      totalRewards[8] += round18RewardPool * BigInt(publicationHeightScores[heights18[8]]) / BigInt(round18PoPScore);
      totalRewards[9] += round18RewardPool * BigInt(publicationHeightScores[heights18[9]]) / BigInt(round18PoPScore);
      totalRewards[10] += round18RewardPool * BigInt(publicationHeightScores[heights18[10]]) / BigInt(round18PoPScore);
      totalRewards[11] += round18RewardPool * BigInt(publicationHeightScores[heights18[11]]) / BigInt(round18PoPScore);
      totalRewards[12] += round18RewardPool * BigInt(publicationHeightScores[heights18[12]]) / BigInt(round18PoPScore);
      totalRewards[13] += round18RewardPool * BigInt(publicationHeightScores[heights18[13]]) / BigInt(round18PoPScore);
      totalRewards[14] += round18RewardPool * BigInt(publicationHeightScores[heights18[14]]) / BigInt(round18PoPScore);
      totalRewards[15] += round18RewardPool * BigInt(publicationHeightScores[heights18[15]]) / BigInt(round18PoPScore);

      const r18AdjustedPool = (round18RewardPool * ((TARGET_SCORE * BPS) / BigInt(round18PoPScore))) / BPS;

      // 16 optimal publications (assumes massive spike from missed round encourages lots of publications)
      const addresses19: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
      ];

      const heights19: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0
      ];

      const round19PoPScore = publicationHeightScores[heights19[0]] + publicationHeightScores[heights19[1]] + publicationHeightScores[heights19[2]] +
        publicationHeightScores[heights19[3]] + publicationHeightScores[heights19[4]] + publicationHeightScores[heights19[5]] +
        publicationHeightScores[heights19[6]] + publicationHeightScores[heights19[7]] + publicationHeightScores[heights19[8]] +
        publicationHeightScores[heights19[9]] + publicationHeightScores[heights19[10]] + publicationHeightScores[heights19[11]] +
        publicationHeightScores[heights19[12]] + publicationHeightScores[heights19[13]] + publicationHeightScores[heights19[14]] +
        publicationHeightScores[heights19[15]];

      const round19RewardPool = (r7AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r8AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r17AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r18AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (475), addresses19, heights19
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(475, round19RewardPool, round19PoPScore);

      totalRewards[0] += round19RewardPool * BigInt(publicationHeightScores[heights19[0]]) / BigInt(round19PoPScore);
      totalRewards[1] += round19RewardPool * BigInt(publicationHeightScores[heights19[1]]) / BigInt(round19PoPScore);
      totalRewards[2] += round19RewardPool * BigInt(publicationHeightScores[heights19[2]]) / BigInt(round19PoPScore);
      totalRewards[3] += round19RewardPool * BigInt(publicationHeightScores[heights19[3]]) / BigInt(round19PoPScore);
      totalRewards[4] += round19RewardPool * BigInt(publicationHeightScores[heights19[4]]) / BigInt(round19PoPScore);
      totalRewards[5] += round19RewardPool * BigInt(publicationHeightScores[heights19[5]]) / BigInt(round19PoPScore);
      totalRewards[6] += round19RewardPool * BigInt(publicationHeightScores[heights19[6]]) / BigInt(round19PoPScore);
      totalRewards[7] += round19RewardPool * BigInt(publicationHeightScores[heights19[7]]) / BigInt(round19PoPScore);
      totalRewards[8] += round19RewardPool * BigInt(publicationHeightScores[heights19[8]]) / BigInt(round19PoPScore);
      totalRewards[9] += round19RewardPool * BigInt(publicationHeightScores[heights19[9]]) / BigInt(round19PoPScore);
      totalRewards[10] += round19RewardPool * BigInt(publicationHeightScores[heights19[10]]) / BigInt(round19PoPScore);
      totalRewards[11] += round19RewardPool * BigInt(publicationHeightScores[heights19[11]]) / BigInt(round19PoPScore);
      totalRewards[12] += round19RewardPool * BigInt(publicationHeightScores[heights19[12]]) / BigInt(round19PoPScore);
      totalRewards[13] += round19RewardPool * BigInt(publicationHeightScores[heights19[13]]) / BigInt(round19PoPScore);
      totalRewards[14] += round19RewardPool * BigInt(publicationHeightScores[heights19[14]]) / BigInt(round19PoPScore);
      totalRewards[15] += round19RewardPool * BigInt(publicationHeightScores[heights19[15]]) / BigInt(round19PoPScore);

      // Check our running totals of rewards against what was sent on-chain
      expect(await HemiContract.balanceOf(addresses18[0])).to.equal(totalRewards[0]);
      expect(await HemiContract.balanceOf(addresses18[1])).to.equal(totalRewards[1]);
      expect(await HemiContract.balanceOf(addresses18[2])).to.equal(totalRewards[2] + totalRewards[4]); // Duplicated address
      expect(await HemiContract.balanceOf(addresses18[3])).to.equal(totalRewards[3]);
      expect(await HemiContract.balanceOf(addresses18[5])).to.equal(totalRewards[5]);
      expect(await HemiContract.balanceOf(addresses18[6])).to.equal(totalRewards[6]);
      expect(await HemiContract.balanceOf(addresses18[7])).to.equal(totalRewards[7]);
      expect(await HemiContract.balanceOf(addresses18[8])).to.equal(totalRewards[8]);
      expect(await HemiContract.balanceOf(addresses18[9])).to.equal(totalRewards[9]);
      expect(await HemiContract.balanceOf(addresses18[10])).to.equal(totalRewards[10]);
      expect(await HemiContract.balanceOf(addresses18[11])).to.equal(totalRewards[11]);
      expect(await HemiContract.balanceOf(addresses18[12])).to.equal(totalRewards[12]);
      expect(await HemiContract.balanceOf(addresses18[13])).to.equal(totalRewards[13]);
      expect(await HemiContract.balanceOf(addresses18[14])).to.equal(totalRewards[14]);
      expect(await HemiContract.balanceOf(addresses18[15])).to.equal(totalRewards[15]);

     const r19AdjustedPool = (round19RewardPool * ((TARGET_SCORE * BPS) / BigInt(round19PoPScore))) / BPS;

      // 16 optimal publications (assumes massive spike from missed round encourages lots of publications)
      const addresses20: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
      ];

      const heights20: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0
      ];

      const round20PoPScore = publicationHeightScores[heights20[0]] + publicationHeightScores[heights20[1]] + publicationHeightScores[heights20[2]] +
        publicationHeightScores[heights20[3]] + publicationHeightScores[heights20[4]] + publicationHeightScores[heights20[5]] +
        publicationHeightScores[heights20[6]] + publicationHeightScores[heights20[7]] + publicationHeightScores[heights20[8]] +
        publicationHeightScores[heights20[9]] + publicationHeightScores[heights20[10]] + publicationHeightScores[heights20[11]] +
        publicationHeightScores[heights20[12]] + publicationHeightScores[heights20[13]] + publicationHeightScores[heights20[14]] +
        publicationHeightScores[heights20[15]];

      const round20RewardPool = (r8AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r9AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r17AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r18AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r19AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (500), addresses20, heights20
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(500, round20RewardPool, round20PoPScore);

      totalRewards[0] += round20RewardPool * BigInt(publicationHeightScores[heights20[0]]) / BigInt(round20PoPScore);
      totalRewards[1] += round20RewardPool * BigInt(publicationHeightScores[heights20[1]]) / BigInt(round20PoPScore);
      totalRewards[2] += round20RewardPool * BigInt(publicationHeightScores[heights20[2]]) / BigInt(round20PoPScore);
      totalRewards[3] += round20RewardPool * BigInt(publicationHeightScores[heights20[3]]) / BigInt(round20PoPScore);
      totalRewards[4] += round20RewardPool * BigInt(publicationHeightScores[heights20[4]]) / BigInt(round20PoPScore);
      totalRewards[5] += round20RewardPool * BigInt(publicationHeightScores[heights20[5]]) / BigInt(round20PoPScore);
      totalRewards[6] += round20RewardPool * BigInt(publicationHeightScores[heights20[6]]) / BigInt(round20PoPScore);
      totalRewards[7] += round20RewardPool * BigInt(publicationHeightScores[heights20[7]]) / BigInt(round20PoPScore);
      totalRewards[8] += round20RewardPool * BigInt(publicationHeightScores[heights20[8]]) / BigInt(round20PoPScore);
      totalRewards[9] += round20RewardPool * BigInt(publicationHeightScores[heights20[9]]) / BigInt(round20PoPScore);
      totalRewards[10] += round20RewardPool * BigInt(publicationHeightScores[heights20[10]]) / BigInt(round20PoPScore);
      totalRewards[11] += round20RewardPool * BigInt(publicationHeightScores[heights20[11]]) / BigInt(round20PoPScore);
      totalRewards[12] += round20RewardPool * BigInt(publicationHeightScores[heights20[12]]) / BigInt(round20PoPScore);
      totalRewards[13] += round20RewardPool * BigInt(publicationHeightScores[heights20[13]]) / BigInt(round20PoPScore);
      totalRewards[14] += round20RewardPool * BigInt(publicationHeightScores[heights20[14]]) / BigInt(round20PoPScore);
      totalRewards[15] += round20RewardPool * BigInt(publicationHeightScores[heights20[15]]) / BigInt(round20PoPScore);


     const r20AdjustedPool = (round20RewardPool * ((TARGET_SCORE * BPS) / BigInt(round20PoPScore))) / BPS;

      // 16 optimal publications (assumes massive spike from missed round encourages lots of publications)
      const addresses21: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
      ];

      const heights21: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0
      ];

      const round21PoPScore = publicationHeightScores[heights21[0]] + publicationHeightScores[heights21[1]] + publicationHeightScores[heights21[2]] +
        publicationHeightScores[heights21[3]] + publicationHeightScores[heights21[4]] + publicationHeightScores[heights21[5]] +
        publicationHeightScores[heights21[6]] + publicationHeightScores[heights21[7]] + publicationHeightScores[heights21[8]] +
        publicationHeightScores[heights21[9]] + publicationHeightScores[heights21[10]] + publicationHeightScores[heights21[11]] +
        publicationHeightScores[heights21[12]] + publicationHeightScores[heights21[13]] + publicationHeightScores[heights21[14]] +
        publicationHeightScores[heights21[15]];

      const round21RewardPool = (r9AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r10AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r17AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r18AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r19AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r20AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (525), addresses21, heights21
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(525, round21RewardPool, round21PoPScore);

      totalRewards[0] += round21RewardPool * BigInt(publicationHeightScores[heights21[0]]) / BigInt(round21PoPScore);
      totalRewards[1] += round21RewardPool * BigInt(publicationHeightScores[heights21[1]]) / BigInt(round21PoPScore);
      totalRewards[2] += round21RewardPool * BigInt(publicationHeightScores[heights21[2]]) / BigInt(round21PoPScore);
      totalRewards[3] += round21RewardPool * BigInt(publicationHeightScores[heights21[3]]) / BigInt(round21PoPScore);
      totalRewards[4] += round21RewardPool * BigInt(publicationHeightScores[heights21[4]]) / BigInt(round21PoPScore);
      totalRewards[5] += round21RewardPool * BigInt(publicationHeightScores[heights21[5]]) / BigInt(round21PoPScore);
      totalRewards[6] += round21RewardPool * BigInt(publicationHeightScores[heights21[6]]) / BigInt(round21PoPScore);
      totalRewards[7] += round21RewardPool * BigInt(publicationHeightScores[heights21[7]]) / BigInt(round21PoPScore);
      totalRewards[8] += round21RewardPool * BigInt(publicationHeightScores[heights21[8]]) / BigInt(round21PoPScore);
      totalRewards[9] += round21RewardPool * BigInt(publicationHeightScores[heights21[9]]) / BigInt(round21PoPScore);
      totalRewards[10] += round21RewardPool * BigInt(publicationHeightScores[heights21[10]]) / BigInt(round21PoPScore);
      totalRewards[11] += round21RewardPool * BigInt(publicationHeightScores[heights21[11]]) / BigInt(round21PoPScore);
      totalRewards[12] += round21RewardPool * BigInt(publicationHeightScores[heights21[12]]) / BigInt(round21PoPScore);
      totalRewards[13] += round21RewardPool * BigInt(publicationHeightScores[heights21[13]]) / BigInt(round21PoPScore);
      totalRewards[14] += round21RewardPool * BigInt(publicationHeightScores[heights21[14]]) / BigInt(round21PoPScore);
      totalRewards[15] += round21RewardPool * BigInt(publicationHeightScores[heights21[15]]) / BigInt(round21PoPScore);

     const r21AdjustedPool = (round21RewardPool * ((TARGET_SCORE * BPS) / BigInt(round21PoPScore))) / BPS;

      // 16 optimal publications (assumes massive spike from missed round encourages lots of publications)
      const addresses22: string[] = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002", 
        "0xf100000000000000000000000000000000000003", // Duplicate x2
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000003",  // Duplicate x2
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
        "0xf100000000000000000000000000000000000008",
        "0xf100000000000000000000000000000000000009",
        "0xf10000000000000000000000000000000000000a",
        "0xf10000000000000000000000000000000000000b",
        "0xf10000000000000000000000000000000000000c",
        "0xf10000000000000000000000000000000000000d",
        "0xf10000000000000000000000000000000000000e",
        "0xf10000000000000000000000000000000000000f",
      ];

      const heights22: number[] = [
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0
      ];

      const round22PoPScore = publicationHeightScores[heights22[0]] + publicationHeightScores[heights22[1]] + publicationHeightScores[heights22[2]] +
        publicationHeightScores[heights22[3]] + publicationHeightScores[heights22[4]] + publicationHeightScores[heights22[5]] +
        publicationHeightScores[heights22[6]] + publicationHeightScores[heights22[7]] + publicationHeightScores[heights22[8]] +
        publicationHeightScores[heights22[9]] + publicationHeightScores[heights22[10]] + publicationHeightScores[heights22[11]] +
        publicationHeightScores[heights22[12]] + publicationHeightScores[heights22[13]] + publicationHeightScores[heights22[14]] +
        publicationHeightScores[heights22[15]];

      const round22RewardPool = (r10AdjustedPool * BigInt(rewardLookbackWeighting[11]) + 
        r11AdjustedPool * BigInt(rewardLookbackWeighting[10]) + 
        r12AdjustedPool * BigInt(rewardLookbackWeighting[9]) + 
        r13AdjustedPool * BigInt(rewardLookbackWeighting[8]) + 
        r14AdjustedPool * BigInt(rewardLookbackWeighting[7]) + 
        r15AdjustedPool * BigInt(rewardLookbackWeighting[6]) + 
        r16AdjustedPool * BigInt(rewardLookbackWeighting[5]) + 
        r17AdjustedPool * BigInt(rewardLookbackWeighting[4]) + 
        r18AdjustedPool * BigInt(rewardLookbackWeighting[3]) + 
        r19AdjustedPool * BigInt(rewardLookbackWeighting[2]) + 
        r20AdjustedPool * BigInt(rewardLookbackWeighting[1]) + 
        r21AdjustedPool * BigInt(rewardLookbackWeighting[0])) / 
        (BigInt(rewardLookbackWeighting[0] + rewardLookbackWeighting[1] + rewardLookbackWeighting[2] + rewardLookbackWeighting[3] + 
          rewardLookbackWeighting[4] + rewardLookbackWeighting[5] + rewardLookbackWeighting[6] + rewardLookbackWeighting[7] +
          rewardLookbackWeighting[8] + rewardLookbackWeighting[9] + rewardLookbackWeighting[10] + rewardLookbackWeighting[11]
        ));

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        (550), addresses22, heights22
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(550, round22RewardPool, round22PoPScore);

      totalRewards[0] += round22RewardPool * BigInt(publicationHeightScores[heights22[0]]) / BigInt(round22PoPScore);
      totalRewards[1] += round22RewardPool * BigInt(publicationHeightScores[heights22[1]]) / BigInt(round22PoPScore);
      totalRewards[2] += round22RewardPool * BigInt(publicationHeightScores[heights22[2]]) / BigInt(round22PoPScore);
      totalRewards[3] += round22RewardPool * BigInt(publicationHeightScores[heights22[3]]) / BigInt(round22PoPScore);
      totalRewards[4] += round22RewardPool * BigInt(publicationHeightScores[heights22[4]]) / BigInt(round22PoPScore);
      totalRewards[5] += round22RewardPool * BigInt(publicationHeightScores[heights22[5]]) / BigInt(round22PoPScore);
      totalRewards[6] += round22RewardPool * BigInt(publicationHeightScores[heights22[6]]) / BigInt(round22PoPScore);
      totalRewards[7] += round22RewardPool * BigInt(publicationHeightScores[heights22[7]]) / BigInt(round22PoPScore);
      totalRewards[8] += round22RewardPool * BigInt(publicationHeightScores[heights22[8]]) / BigInt(round22PoPScore);
      totalRewards[9] += round22RewardPool * BigInt(publicationHeightScores[heights22[9]]) / BigInt(round22PoPScore);
      totalRewards[10] += round22RewardPool * BigInt(publicationHeightScores[heights22[10]]) / BigInt(round22PoPScore);
      totalRewards[11] += round22RewardPool * BigInt(publicationHeightScores[heights22[11]]) / BigInt(round22PoPScore);
      totalRewards[12] += round22RewardPool * BigInt(publicationHeightScores[heights22[12]]) / BigInt(round22PoPScore);
      totalRewards[13] += round22RewardPool * BigInt(publicationHeightScores[heights22[13]]) / BigInt(round22PoPScore);
      totalRewards[14] += round22RewardPool * BigInt(publicationHeightScores[heights22[14]]) / BigInt(round22PoPScore);
      totalRewards[15] += round22RewardPool * BigInt(publicationHeightScores[heights22[15]]) / BigInt(round22PoPScore);

      // Check our running totals of rewards against what was sent on-chain
      expect(await HemiContract.balanceOf(addresses20[0])).to.equal(totalRewards[0]);
      expect(await HemiContract.balanceOf(addresses20[1])).to.equal(totalRewards[1]);
      expect(await HemiContract.balanceOf(addresses20[2])).to.equal(totalRewards[2] + totalRewards[4]); // Duplicated address
      expect(await HemiContract.balanceOf(addresses20[3])).to.equal(totalRewards[3]);
      expect(await HemiContract.balanceOf(addresses20[5])).to.equal(totalRewards[5]);
      expect(await HemiContract.balanceOf(addresses20[6])).to.equal(totalRewards[6]);
      expect(await HemiContract.balanceOf(addresses20[7])).to.equal(totalRewards[7]);
      expect(await HemiContract.balanceOf(addresses20[8])).to.equal(totalRewards[8]);
      expect(await HemiContract.balanceOf(addresses20[9])).to.equal(totalRewards[9]);
      expect(await HemiContract.balanceOf(addresses20[10])).to.equal(totalRewards[10]);
      expect(await HemiContract.balanceOf(addresses20[11])).to.equal(totalRewards[11]);
      expect(await HemiContract.balanceOf(addresses20[12])).to.equal(totalRewards[12]);
      expect(await HemiContract.balanceOf(addresses20[13])).to.equal(totalRewards[13]);
      expect(await HemiContract.balanceOf(addresses20[14])).to.equal(totalRewards[14]);
      expect(await HemiContract.balanceOf(addresses20[15])).to.equal(totalRewards[15]);
    });

    it("30 regular rounds, 26 skipped rounds, and 30 regular rounds should be calculated correctly", async function () {
      const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await expect(HemiContract.connect(initialMintReceiver).transfer(
        PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
      )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

      const wallets = Array.from({ length: 750 }, () => hre.ethers.Wallet.createRandom());
      const rewards: Map<string, bigint> = new Map();

      for (let i = 0; i < wallets.length; i++) {
        rewards.set(wallets[i].address, 0n);
      }

      var oldRoundData : bigint[][] = [];

      // Round 1-30
      var roundRewardPool = INITIAL_REWARD;
      for (let round = 1; round <= 30; round++) {
        await time.increase(25 * 11);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

        const { addresses, heights } = calculateRandomAddressesAndWeights(wallets, 20, 7);

        var popScore = 0;
        for (let i = 0; i < heights.length; i++) {
          popScore += publicationHeightScores[heights[i]];
        }

        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (round * 25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs((round * 25), roundRewardPool, popScore);

        oldRoundData.push([]);
        oldRoundData[round - 1][0] = roundRewardPool;
        oldRoundData[round - 1][1] = BigInt(popScore);

        const currentTimestamp = await time.latest();
        roundRewardPool = await calculateRoundRewardPool(oldRoundData, supplyTimestamp, INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, currentTimestamp);
      }

      // Skip rounds 31-56
      await time.increase(25 * 11 * 26);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25 * 26).toString(16)]);

      // Populate all recent rounds with maximum reward and zero score
      for (let i = 0; i < rewardLookbackWeighting.length; i++) {
        const currentTimestamp = await time.latest();
        oldRoundData.push([]);
        // calculateMaximumRewardPool(supplyTimestamp: number, supplyBase: bigint, yearlyInflation: number, popInflation: number, rewardTimestamp: number)
        oldRoundData[30 + i][0] = await calculateMaximumRewardPool(supplyTimestamp, INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, currentTimestamp);
        oldRoundData[30 + i][1] = 0n;
      }

      await time.increase(1);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(1).toString(16)]);

      const currentTimestamp = await time.latest();

      // Rounds 57-86
      roundRewardPool = await calculateMaximumRewardPool(supplyTimestamp, INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, currentTimestamp);

      for (let round = 57; round <= 86; round++) {
        // console.log("Calculated reward pool for round %d: %d", round, roundRewardPool);
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

        // Average of 30/2=15 publications between heights 0 and 2, should recover quickly
        const { addresses, heights } = calculateRandomAddressesAndWeights(wallets, 30, 3);

        var popScore = 0;
        for (let i = 0; i < heights.length; i++) {
          popScore += publicationHeightScores[heights[i]];
        }


        await time.increase(1);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(1).toString(16)]);

        var popScore = 0;
        for (let i = 0; i < heights.length; i++) {
          popScore += publicationHeightScores[heights[i]];
        }

        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (round * 25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs((round * 25), roundRewardPool, popScore);

        oldRoundData.push([]);
        oldRoundData[oldRoundData.length - 1][0] = roundRewardPool;
        oldRoundData[oldRoundData.length - 1][1] = BigInt(popScore);

        const latestTimestamp = await time.latest();
        roundRewardPool = await calculateRoundRewardPool(oldRoundData, supplyTimestamp, INITIAL_SUPPLY, YEARLY_TOKEN_INFLATION, POP_INFLATION_ALLOCATION, latestTimestamp);
      }

      // Check balances for reward payouts
    });
    it("Optimized backfill (>24 skipped rounds) should emit PayoutRoundExecuted events for all backfilled rounds", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // First call to initialize
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, [], []);

      // Skip 30 rounds (triggers optimized backfill which backfills 13 rounds)
      // Optimized backfill creates rounds for: _blockRewarded - ((12 + 1) * 25) up to _blockRewarded - 25
      const keystonesToSkip = 30;
      await time.increase(25 * 12 * keystonesToSkip);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25 * keystonesToSkip).toString(16)]);

      const targetKeystone = 25 + keystonesToSkip * 25; // = 775

      // The optimized backfill should start at: 775 - (13 * 25) = 775 - 325 = 450
      // And backfill rounds: 450, 475, 500, 525, 550, 575, 600, 625, 650, 675, 700, 725, 750
      // That's 13 backfilled rounds, plus the actual round at 775 = 14 events total

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(targetKeystone, [], []);
      const receipt = await tx.wait();

      // Count PayoutRoundExecuted events
      const payoutEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "PayoutRoundExecuted";
        } catch {
          return false;
        }
      }) || [];

      // Should have 13 backfilled rounds + 1 actual round = 14 events
      expect(payoutEvents.length).to.equal(14);

      // Verify the backfilled rounds have correct block heights
      const startingBackfillBlock = targetKeystone - (13 * 25); // 775 - 325 = 450
      for (let i = 0; i < 13; i++) {
        const expectedBlock = startingBackfillBlock + i * 25;
        const parsed = PoPPayoutsV2Contract.interface.parseLog({
          topics: payoutEvents[i].topics as string[],
          data: payoutEvents[i].data
        });
        expect(parsed?.args[0]).to.equal(expectedBlock); // blockRewarded
        expect(parsed?.args[2]).to.equal(0); // popScore should be 0 for backfilled rounds
      }

      // Verify the final event is for the actual target keystone
      const lastEvent = PoPPayoutsV2Contract.interface.parseLog({
        topics: payoutEvents[13].topics as string[],
        data: payoutEvents[13].data
      });
      expect(lastEvent?.args[0]).to.equal(targetKeystone);
    });

    it("Regular backfill (<=24 skipped rounds) should emit RoundsBackfilled event", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // First, execute round 1 at keystone 25
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, ["0x1111111111111111111111111111111111111111"], [0]);

      // Now skip 5 keystones (regular backfill path) and reward at keystone 175
      // Skipping keystones: 50, 75, 100, 125, 150 (5 rounds)
      await time.increase(150 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(150).toString(16)]);

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(175, ["0x2222222222222222222222222222222222222222"], [0]);
      const receipt = await tx.wait();

      // Find the RoundsBackfilled event
      const backfillEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "RoundsBackfilled";
        } catch {
          return false;
        }
      }) || [];

      expect(backfillEvents.length).to.equal(1);

      const parsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: backfillEvents[0].topics as string[],
        data: backfillEvents[0].data
      });

      // startBlock should be 50 (first backfilled keystone after 25)
      expect(parsed?.args[0]).to.equal(50);
      // endBlock should be 150 (last backfilled keystone)
      expect(parsed?.args[1]).to.equal(150);
      // count should be 5 (backfilled rounds: 50, 75, 100, 125, 150)
      expect(parsed?.args[2]).to.equal(5);
    });

    it("Optimized backfill (>24 skipped rounds) should emit RoundsBackfilled event", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // First call to initialize (required before backfill can occur)
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, [], []);

      // Skip 30 rounds (triggers optimized backfill which backfills 13 rounds)
      const keystonesToSkip = 30;
      await time.increase(25 * 12 * keystonesToSkip);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25 * keystonesToSkip).toString(16)]);

      const targetKeystone = 25 + keystonesToSkip * 25; // = 775

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(targetKeystone, ["0x1111111111111111111111111111111111111111"], [0]);
      const receipt = await tx.wait();

      // Find the RoundsBackfilled event
      const backfillEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "RoundsBackfilled";
        } catch {
          return false;
        }
      }) || [];

      expect(backfillEvents.length).to.equal(1);

      const parsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: backfillEvents[0].topics as string[],
        data: backfillEvents[0].data
      });

      // startBlock should be 775 - (13 * 25) = 450
      const startingBackfillBlock = targetKeystone - (13 * 25);
      expect(parsed?.args[0]).to.equal(startingBackfillBlock);
      // endBlock should be 750 (775 - 25)
      expect(parsed?.args[1]).to.equal(targetKeystone - 25);
      // count should be 13 (optimized backfill always creates 13 rounds)
      expect(parsed?.args[2]).to.equal(13);
    });

    it("No backfill should not emit RoundsBackfilled event", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Execute consecutive rounds with no gaps
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, ["0x1111111111111111111111111111111111111111"], [0]);
      const receipt = await tx.wait();

      // Should NOT find any RoundsBackfilled event
      const backfillEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "RoundsBackfilled";
        } catch {
          return false;
        }
      }) || [];

      expect(backfillEvents.length).to.equal(0);
    });

    it("Optimized backfill cannot underflow startingBackfillBlock", async function () {
      // This test proves that startingBackfillBlock underflow is impossible.
      // The optimized backfill path calculates: startingBackfillBlock = _blockRewarded - 325 (13 * 25)
      //
      // For underflow, we'd need _blockRewarded < 325.
      // But the optimized backfill path only triggers when numRoundsToCalculate > 24.
      //
      // Analysis:
      // 1. First call: lastBlockRewarded = 0 → set to _blockRewarded - 25, so numRoundsToCalculate = 0
      // 2. For numRoundsToCalculate > 24: (_blockRewarded - lastBlockRewarded) / 25 - 1 > 24
      //    → _blockRewarded - lastBlockRewarded > 625
      // 3. Minimum lastBlockRewarded after first call = 25 (first keystone)
      // 4. So minimum _blockRewarded for optimized backfill = 25 + 625 = 650
      // 5. startingBackfillBlock = 650 - 325 = 325 > 0 ✓
      //
      // This test verifies by executing the smallest possible optimized backfill.

      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Execute first round at minimum keystone (25)
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, [], []);

      // To trigger optimized backfill, we need > 24 skipped rounds (numRoundsToCalculate > 24)
      // numRoundsToCalculate = (_blockRewarded - lastBlockRewarded) / 25 - 1
      // For > 24: (_blockRewarded - 25) / 25 - 1 > 24 → _blockRewarded > 650
      // Minimum keystone that triggers optimized backfill: 675 (27 * 25)
      // This gives numRoundsToCalculate = (675 - 25) / 25 - 1 = 25

      const minOptimizedBackfillKeystone = 675; // 27 * 25
      await time.increase((minOptimizedBackfillKeystone - 25) * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(minOptimizedBackfillKeystone - 25).toString(16)]);

      // This should succeed without underflow
      // startingBackfillBlock = 675 - (13 * 25) = 675 - 325 = 350 > 0
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        minOptimizedBackfillKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      const receipt = await tx.wait();

      // Verify optimized backfill occurred (RoundsBackfilled event emitted)
      const backfillEvents = receipt?.logs.filter(log => {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "RoundsBackfilled";
        } catch {
          return false;
        }
      }) || [];

      expect(backfillEvents.length).to.equal(1);

      // Verify the startingBackfillBlock was valid (350)
      const parsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: backfillEvents[0].topics as string[],
        data: backfillEvents[0].data
      });
      expect(parsed?.args[0]).to.equal(350); // startBlock = 675 - 325 = 350
    });

    it("should operate correctly with firstRoundRewards of 1 wei", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy a new contract with 1 wei firstRoundRewards
      const now = await time.latest();
      const { supplyOwner, owner } = await getAddresses();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const contract = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await contract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        1n // 1 wei as firstRoundRewards
      );

      expect(await contract.firstRoundRewards()).to.equal(1n);

      // Fund contract (use initialMintReceiver from the fixture)
      await HemiContract.connect(initialMintReceiver).transfer(contract, INITIAL_PAYOUT_TOKENS);

      // Advance to first keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      // Execute first payout with 1 wei reward
      await expect(contract.connect(await protocolSigner).mintPoPRewards(
        25,
        [random1.address],
        [0]
      )).to.emit(contract, "PayoutRoundExecuted").withArgs(25, 1n, publicationHeightScores[0]);

      // Verify recipient received 1 wei
      expect(await HemiContract.balanceOf(random1.address)).to.equal(1n);

      // Execute second round - reward pool calculation should still work
      // With 1 wei first round and 1 optimal publication (100K score vs 500K target),
      // retargeting multiplier is 5x, so second reward = 5 wei
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(contract.connect(await protocolSigner).mintPoPRewards(
        50,
        [random1.address],
        [0]
      )).to.emit(contract, "PayoutRoundExecuted").withArgs(50, 5n, publicationHeightScores[0]);
    });

    it("should handle payout when contract balance exactly equals reward pool", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract with exactly INITIAL_REWARD (the first round reward pool)
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_REWARD);

      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_REWARD);

      // Advance to first keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      // Execute payout - balance exactly matches reward pool
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        [random1.address],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted").withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      // Contract should now have 0 balance
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(0n);

      // Recipient should have received exactly INITIAL_REWARD
      expect(await HemiContract.balanceOf(random1.address)).to.equal(INITIAL_REWARD);
    });

    it("should distribute rewards correctly with 7 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // 7 miners (prime number) with varying publication heights
      const addresses = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002",
        "0xf100000000000000000000000000000000000003",
        "0xf100000000000000000000000000000000000004",
        "0xf100000000000000000000000000000000000005",
        "0xf100000000000000000000000000000000000006",
        "0xf100000000000000000000000000000000000007",
      ];
      const heights = [0, 0, 1, 2, 3, 4, 5]; // Different heights for varied scores

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      // Calculate expected total score: 100000 + 100000 + 100000 + 25000 + 11111 + 6250 + 4000 = 346361
      const expectedTotalScore = publicationHeightScores[0] + publicationHeightScores[0] +
        publicationHeightScores[1] + publicationHeightScores[2] + publicationHeightScores[3] +
        publicationHeightScores[4] + publicationHeightScores[5];

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted")
        .withArgs(25, INITIAL_REWARD, expectedTotalScore);

      // Calculate total distributed
      let totalDistributed = 0n;
      for (const addr of addresses) {
        totalDistributed += await HemiContract.balanceOf(addr);
      }

      // Total distributed should equal INITIAL_REWARD (allowing for potential dust)
      // Due to integer division, might be slightly less
      expect(totalDistributed).to.be.lte(INITIAL_REWARD);
      expect(INITIAL_REWARD - totalDistributed).to.be.lt(BigInt(addresses.length)); // Dust should be minimal
    });

    it("should distribute rewards correctly with 3 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // 3 miners - smallest odd prime
      const addresses = [
        "0xf100000000000000000000000000000000000001",
        "0xf100000000000000000000000000000000000002",
        "0xf100000000000000000000000000000000000003",
      ];
      const heights = [0, 0, 0]; // All optimal for equal distribution

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      // Total score: 3 * 100000 = 300000
      const expectedTotalScore = publicationHeightScores[0] * 3;

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted")
        .withArgs(25, INITIAL_REWARD, expectedTotalScore);

      // With 3 equal-score miners, reward is INITIAL_REWARD / 3
      // Due to integer division, each gets floor(INITIAL_REWARD / 3)
      const expectedPerMiner = INITIAL_REWARD / 3n;

      for (const addr of addresses) {
        expect(await HemiContract.balanceOf(addr)).to.equal(expectedPerMiner);
      }

      // Verify dust (remainder) stays in contract
      const dust = INITIAL_REWARD - (expectedPerMiner * 3n);
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS - (expectedPerMiner * 3n));
    });

    it("should calculate maximum reward pool correctly when rewardTimestamp equals supplyTimestamp", async function () {
      const { PoPPayoutsV2Contract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Calculate max reward at exactly supplyTimestamp (0 complete mintage periods)
      const maxReward = await PoPPayoutsV2Contract.calculateMaximumRewardPool(supplyTimestamp);

      // At supplyTimestamp, circulating supply = INITIAL_SUPPLY (no inflation yet)
      // Verify supply at supplyTimestamp is INITIAL_SUPPLY
      const supplyAtTimestamp = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp);
      expect(supplyAtTimestamp).to.equal(INITIAL_SUPPLY);

      // Calculate expected maximum reward pool using the contract's formula:
      // From PoPPayoutsV2.sol calculateMaximumRewardPool():
      //   nextMonthPoPEmissions = (currentSupply * popInflationAllocation * MINTAGE_PERIOD) / (YEAR * MAX_BPS)
      //   maxReward = nextMonthPoPEmissions / (MINTAGE_PERIOD / BLOCK_TIME_SEC / KEYSTONE_FREQUENCY)
      //
      // Constants:
      //   YEAR = 365.25 days = 31557600 seconds
      //   MAX_BPS = 10000
      //   MINTAGE_PERIOD = 30 days = 2592000 seconds
      //   BLOCK_TIME_SEC = 12
      //   KEYSTONE_FREQUENCY = 25
      //   popInflationAllocation = 500 (5%)

      const YEAR_SECONDS = BigInt(Math.floor(365.25 * 24 * 60 * 60)); // 31557600
      const MAX_BPS = 10000n;
      const MINTAGE_PERIOD_SECONDS = BigInt(MINTAGE_PERIOD);

      // Step 1: Calculate next month's PoP emissions
      const nextMonthPoPEmissions = (INITIAL_SUPPLY * BigInt(POP_INFLATION_ALLOCATION) * MINTAGE_PERIOD_SECONDS)
                                    / (YEAR_SECONDS * MAX_BPS);

      // Step 2: Calculate keystones per mintage period
      const keystonesPerMintage = MINTAGE_PERIOD_SECONDS / BigInt(BLOCK_TIME_SEC) / BigInt(KEYSTONE_FREQUENCY);

      // Step 3: Calculate expected max reward per keystone
      const expectedMaxReward = nextMonthPoPEmissions / keystonesPerMintage;

      // Verify the contract's calculation matches our expected value exactly
      expect(maxReward).to.equal(expectedMaxReward,
        `Contract maxReward (${maxReward}) should equal calculated expectedMaxReward (${expectedMaxReward})`);

      // Also verify the intermediate calculation: keystones per mintage should be 8640
      // 2592000 / 12 / 25 = 8640
      expect(keystonesPerMintage).to.equal(8640n, "Keystones per mintage period should be 8640");

      // Verify maxReward is non-zero
      expect(maxReward).to.be.gt(0n);

      // Verify firstRoundRewards is less than or equal to maxReward
      const firstRoundRewards = await PoPPayoutsV2Contract.firstRoundRewards();
      expect(firstRoundRewards).to.be.lte(maxReward,
        "firstRoundRewards should be <= maximum allowed by inflation");
    });

    it("should accept exactly 75 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
      const addresses = wallets.map(w => w.address);
      const heights = Array.from({ length: 75 }, (_, i) => i % 9);
      heights[0] = 0; // Ensure at least one height 0

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");
    });

    it("should revert on 76 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const wallets = Array.from({ length: 76 }, () => hre.ethers.Wallet.createRandom());
      const addresses = wallets.map(w => w.address);
      const heights = Array.from({ length: 76 }, (_, i) => i % 9);
      heights[0] = 0;

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.be.revertedWith("Too many publications for single keystone");
    });

    it("should revert on 100 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const wallets = Array.from({ length: 100 }, () => hre.ethers.Wallet.createRandom());
      const addresses = wallets.map(w => w.address);
      const heights = Array.from({ length: 100 }, (_, i) => i % 9);
      heights[0] = 0;

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.be.revertedWith("Too many publications for single keystone");
    });

    it("should revert on 1000 publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const wallets = Array.from({ length: 1000 }, () => hre.ethers.Wallet.createRandom());
      const addresses = wallets.map(w => w.address);
      const heights = Array.from({ length: 1000 }, (_, i) => i % 9);
      heights[0] = 0;

      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25, addresses, heights
      )).to.be.revertedWith("Too many publications for single keystone");
    });

    it("should correctly handle zero publications: emit a non-zero reward pool but no payout", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);

      // Do payout with zero publications
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(25, [], []);
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });

      // Should emit event with rewardPool > 0 but popScore = 0
      expect(parsed?.args[1]).to.be.gt(0n); // rewardPool
      expect(parsed?.args[2]).to.equal(0n); // popScore

      // Contract balance should be unchanged (no tokens distributed)
      const finalBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      expect(finalBalance).to.equal(initialBalance);
    });

    it("should correctly calculate reward pool with only 1 round of history", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // First round uses firstRoundRewards
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(1n);

      // Verify first round got initial reward
      const round0 = await PoPPayoutsV2Contract.rounds(0);
      expect(round0.rewardPool).to.equal(INITIAL_REWARD);
      expect(round0.totalPoPScore).to.equal(BigInt(100000)); // 1 optimal publication

      // Advance to next keystone - use previous keystone + KEYSTONE_FREQUENCY to ensure
      // exactly one keystone period gap (avoids test isolation issues with block numbers)
      const nextKeystone = keystone + KEYSTONE_FREQUENCY;
      await time.increase(KEYSTONE_FREQUENCY * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);
      keystone = nextKeystone;

      // Second round should use lookback with only 1 round of history
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      // Verify round 2 completed
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(2n);

      // The reward pool should be calculated using only 1 round of history
      // With 100,000 points (1 optimal publication), retargeting multiplier is 5x
      // So reward should be exactly 5x the first round reward (using only weight[0])
      const round1 = await PoPPayoutsV2Contract.rounds(1);
      const expectedReward = INITIAL_REWARD * BigInt(5); // 5x multiplier for 20% of target
      expect(round1.rewardPool).to.equal(expectedReward);
      expect(round1.totalPoPScore).to.equal(BigInt(100000));
    });

    it("should correctly calculate reward pool with exactly 6 rounds of history", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Track reward pools as we execute rounds
      const rewardPools: bigint[] = [];

      // Execute 6 rounds with explicit keystone increments to avoid skips
      for (let i = 0; i < 6; i++) {
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          ["0x1111111111111111111111111111111111111111"],
          [0]
        );

        const round = await PoPPayoutsV2Contract.rounds(i);
        rewardPools.push(round.rewardPool);

        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);
        keystone += KEYSTONE_FREQUENCY;
      }

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(6n);

      // 7th round uses 6 rounds of history (partial lookback)
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(7n);

      // Verify the 7th round was calculated correctly using 6 rounds of history
      const round6 = await PoPPayoutsV2Contract.rounds(6);
      expect(round6.rewardPool).to.be.gt(0n);
      expect(round6.totalPoPScore).to.equal(BigInt(100000));

      // Calculate expected reward pool using 6 rounds of weighted history
      // All rounds have 100K score (1 optimal pub), so all get 5x multiplier
      let weightedSum = BigInt(0);
      let totalWeight = BigInt(0);
      for (let i = 0; i < 6; i++) {
        const weight = BigInt(rewardLookbackWeighting[i]);
        weightedSum += rewardPools[5 - i] * BigInt(5) * weight; // 5x multiplier, most recent first
        totalWeight += weight;
      }
      const expectedReward = weightedSum / totalWeight;

      // Verify the calculated reward matches (may be capped by maximum)
      expect(round6.rewardPool).to.be.lte(MAXIMUM_INITIAL_REWARD);
      expect(round6.rewardPool).to.equal(expectedReward > MAXIMUM_INITIAL_REWARD ? MAXIMUM_INITIAL_REWARD : expectedReward);
    });

    it("should correctly calculate reward pool with exactly 11 rounds of history", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Track reward pools as we execute rounds
      const rewardPools: bigint[] = [];

      // Execute 11 rounds with explicit keystone increments to avoid skips
      for (let i = 0; i < 11; i++) {
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          ["0x1111111111111111111111111111111111111111"],
          [0]
        );

        const round = await PoPPayoutsV2Contract.rounds(i);
        rewardPools.push(round.rewardPool);

        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);
        keystone += KEYSTONE_FREQUENCY;
      }

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(11n);

      // 12th round uses 11 rounds of history (still partial lookback, just under full 12)
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(12n);

      // Verify 12th round was calculated using 11 rounds of history
      const round11 = await PoPPayoutsV2Contract.rounds(11);
      expect(round11.rewardPool).to.be.gt(0n);
      expect(round11.totalPoPScore).to.equal(BigInt(100000));

      // Calculate expected reward pool using 11 rounds of weighted history
      let weightedSum = BigInt(0);
      let totalWeight = BigInt(0);
      for (let i = 0; i < 11; i++) {
        const weight = BigInt(rewardLookbackWeighting[i]);
        weightedSum += rewardPools[10 - i] * BigInt(5) * weight; // 5x multiplier, most recent first
        totalWeight += weight;
      }
      const expectedReward = weightedSum / totalWeight;

      // Verify the calculated reward matches (may be capped by maximum)
      expect(round11.rewardPool).to.be.lte(MAXIMUM_INITIAL_REWARD);
      expect(round11.rewardPool).to.equal(expectedReward > MAXIMUM_INITIAL_REWARD ? MAXIMUM_INITIAL_REWARD : expectedReward);
    });

    it("should correctly calculate reward pool with exactly 12 rounds of history (full lookback)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Track reward pools as we execute rounds
      const rewardPools: bigint[] = [];

      // Execute 12 rounds with explicit keystone increments to avoid skips
      for (let i = 0; i < 12; i++) {
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          ["0x1111111111111111111111111111111111111111"],
          [0]
        );

        const round = await PoPPayoutsV2Contract.rounds(i);
        rewardPools.push(round.rewardPool);

        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);
        keystone += KEYSTONE_FREQUENCY;
      }

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(12n);

      // 13th round uses full 12 rounds of history
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(13n);

      // Verify 13th round was calculated correctly using full 12 rounds of history
      const round12 = await PoPPayoutsV2Contract.rounds(12);
      expect(round12.rewardPool).to.be.gt(0n);
      expect(round12.totalPoPScore).to.equal(BigInt(100000));

      // Calculate expected reward pool using all 12 rounds of weighted history
      let weightedSum = BigInt(0);
      let totalWeight = BigInt(0);
      for (let i = 0; i < 12; i++) {
        const weight = BigInt(rewardLookbackWeighting[i]);
        weightedSum += rewardPools[11 - i] * BigInt(5) * weight; // 5x multiplier, most recent first
        totalWeight += weight;
      }
      const expectedReward = weightedSum / totalWeight;

      // Verify the calculated reward matches (may be capped by maximum)
      expect(round12.rewardPool).to.be.lte(MAXIMUM_INITIAL_REWARD);
      expect(round12.rewardPool).to.equal(expectedReward > MAXIMUM_INITIAL_REWARD ? MAXIMUM_INITIAL_REWARD : expectedReward);
    });

    // Helper to get next valid keystone at or after a block number
    function getNextKeystone(blockNumber: number): number {
      return Math.ceil(blockNumber / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;
    }

    // Deploy with MockRevertingERC20 to test failure scenarios
    async function deployWithMockRevertingToken() {
      const { hemiTokenOwner, initialMintReceiver, supplyOwner, owner, random1, random2, random3, random4 } = await getAddresses();

      // Deploy MockRevertingERC20 token
      const MockRevertingERC20Factory = await hre.ethers.getContractFactory("MockRevertingERC20");
      const MockToken = await MockRevertingERC20Factory.deploy(
        "MockHemi",
        "MHEMI",
        INITIAL_SUPPLY
      );

      // Transfer tokens to initialMintReceiver to match the regular setup
      await MockToken.transfer(initialMintReceiver.address, INITIAL_SUPPLY);

      // Use a supply timestamp far in the past to avoid "time cannot be below supply timestamp" errors
      // when running after other tests that have advanced the blockchain
      const supplyTimestamp = 1;

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
        owner.address,
        supplyOwner.address,
        MockToken,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp,
        INITIAL_REWARD
      );

      // Get current block number to calculate valid keystones
      const currentBlock = await hre.ethers.provider.getBlockNumber();

      return { PoPPayoutsV2Contract, supplyOwner, owner, MockToken, initialMintReceiver, random1, random2, supplyTimestamp, currentBlock };
    }

    it("should not modify lastBlockRewarded when mintPoPRewards fails due to require check", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Get initial state
      const initialLastBlockRewarded = await PoPPayoutsV2Contract.lastBlockRewarded();
      const initialNextRoundIndex = await PoPPayoutsV2Contract.getRoundsCount();
      const initialTotalPoPRewards = await PoPPayoutsV2Contract.totalPoPRewards();

      // Calculate a valid keystone based on current block
      const firstKeystone = getNextKeystone(currentBlock + 50);

      // Advance blockchain for valid keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // First, complete a successful round
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      // Record state after successful round
      const lastBlockRewardedAfterSuccess = await PoPPayoutsV2Contract.lastBlockRewarded();
      const nextRoundIndexAfterSuccess = await PoPPayoutsV2Contract.getRoundsCount();
      const totalPoPRewardsAfterSuccess = await PoPPayoutsV2Contract.totalPoPRewards();

      // Verify state changed
      expect(lastBlockRewardedAfterSuccess).to.equal(BigInt(firstKeystone));
      expect(nextRoundIndexAfterSuccess).to.equal(1n);

      // Now try to reward the same keystone again - should fail with "Cannot reward keystones out-of-order"
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      )).to.be.revertedWith("Cannot reward keystones out-of-order");

      // Verify state unchanged after failed call
      expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(lastBlockRewardedAfterSuccess);
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(nextRoundIndexAfterSuccess);
      expect(await PoPPayoutsV2Contract.totalPoPRewards()).to.equal(totalPoPRewardsAfterSuccess);
    });

    it("should not modify rounds array when payout fails due to insufficient balance", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract with only a tiny amount - not enough for a payout
      const tinyAmount = hre.ethers.parseUnits("1", 18); // Only 1 token
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, tinyAmount);

      // Get initial state
      const initialLastBlockRewarded = await PoPPayoutsV2Contract.lastBlockRewarded();
      const initialNextRoundIndex = await PoPPayoutsV2Contract.getRoundsCount();

      // Calculate a valid keystone based on current block
      const targetKeystone = getNextKeystone(currentBlock + 50);

      // Advance blockchain for valid keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Try to do a payout - should fail due to insufficient balance
      // The INITIAL_REWARD is 100 tokens but we only have 1 token
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        targetKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.be.revertedWithCustomError(MockToken, "ERC20InsufficientBalance");

      // Verify state unchanged
      expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(initialLastBlockRewarded);
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(initialNextRoundIndex);
    });

    it("should not modify totalPoPRewards when transfer fails", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract with enough tokens
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Calculate valid keystones based on current block
      const firstKeystone = getNextKeystone(currentBlock + 50);
      const secondKeystone = firstKeystone + KEYSTONE_FREQUENCY;

      // Advance blockchain
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Complete first round successfully
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      const totalPoPRewardsAfterFirstRound = await PoPPayoutsV2Contract.totalPoPRewards();
      const lastBlockRewardedAfterFirstRound = await PoPPayoutsV2Contract.lastBlockRewarded();

      // Now configure the token to fail all transfers
      await MockToken.setAlwaysFail(true);

      // Advance to next keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Try to do another payout - should fail
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        secondKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      )).to.be.revertedWith("MockRevertingERC20: transfer failed");

      // Verify totalPoPRewards unchanged
      expect(await PoPPayoutsV2Contract.totalPoPRewards()).to.equal(totalPoPRewardsAfterFirstRound);
      expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(lastBlockRewardedAfterFirstRound);
    });

    it("should maintain atomicity - all publications paid or none when transfer fails mid-distribution", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Addresses that will receive payouts
      const addresses = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333"
      ];

      // Configure token to fail after 1 successful transfer (so first recipient gets paid, but second fails)
      await MockToken.setFailAfterTransfers(1);

      // Calculate a valid keystone based on current block
      const targetKeystone = getNextKeystone(currentBlock + 50);

      // Advance blockchain
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Get initial balances
      const initialBalance1 = await MockToken.balanceOf(addresses[0]);
      const initialBalance2 = await MockToken.balanceOf(addresses[1]);
      const initialBalance3 = await MockToken.balanceOf(addresses[2]);
      const initialContractBalance = await MockToken.balanceOf(PoPPayoutsV2Contract);

      // Try to do a payout with 3 publications - should fail after first transfer
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        targetKeystone,
        addresses,
        [0, 0, 2] // All valid publication heights
      )).to.be.revertedWith("MockRevertingERC20: transfer limit exceeded");

      // Verify atomicity - ALL balances should be unchanged (transaction reverted)
      expect(await MockToken.balanceOf(addresses[0])).to.equal(initialBalance1);
      expect(await MockToken.balanceOf(addresses[1])).to.equal(initialBalance2);
      expect(await MockToken.balanceOf(addresses[2])).to.equal(initialBalance3);
      expect(await MockToken.balanceOf(PoPPayoutsV2Contract)).to.equal(initialContractBalance);
    });

    it("should rollback state if ERC20 transfer reverts mid-distribution", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Calculate valid keystones based on current block
      const firstKeystone = getNextKeystone(currentBlock + 50);
      const secondKeystone = firstKeystone + KEYSTONE_FREQUENCY;

      // Complete first round successfully to establish baseline state
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      // Record state after successful round
      const lastBlockRewardedBefore = await PoPPayoutsV2Contract.lastBlockRewarded();
      const nextRoundIndexBefore = await PoPPayoutsV2Contract.getRoundsCount();
      const totalPoPRewardsBefore = await PoPPayoutsV2Contract.totalPoPRewards();

      // Configure token to fail after 2 successful transfers
      await MockToken.resetTransferCount();
      await MockToken.setFailAfterTransfers(2);

      // Advance to next keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      // Try payout with 5 publications - will fail after 2nd transfer
      const addresses = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444",
        "0x5555555555555555555555555555555555555555"
      ];

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        secondKeystone,
        addresses,
        [0, 1, 2, 3, 4]
      )).to.be.revertedWith("MockRevertingERC20: transfer limit exceeded");

      // Verify ALL state was rolled back - nothing should have changed
      expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(lastBlockRewardedBefore);
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(nextRoundIndexBefore);
      expect(await PoPPayoutsV2Contract.totalPoPRewards()).to.equal(totalPoPRewardsBefore);
    });

    it("should preserve rounds array integrity when multiple backfilled rounds would occur but transfer fails", async function () {
      const { PoPPayoutsV2Contract, MockToken, initialMintReceiver, currentBlock } = await loadFixture(deployWithMockRevertingToken);

      // Fund the contract
      await MockToken.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Calculate valid keystones based on current block
      const firstKeystone = getNextKeystone(currentBlock + 50);
      // Skip 3 keystones to trigger backfilling (75 blocks apart = 3 keystones)
      const skippedKeystone = firstKeystone + (KEYSTONE_FREQUENCY * 3);

      // Complete first round to establish state
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

      const lastBlockRewardedBefore = await PoPPayoutsV2Contract.lastBlockRewarded();
      const nextRoundIndexBefore = await PoPPayoutsV2Contract.getRoundsCount();

      // Configure token to always fail
      await MockToken.setAlwaysFail(true);

      // Skip multiple keystones (would require backfilling)
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      // Try to reward a keystone that skips several rounds - should fail
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        skippedKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      )).to.be.revertedWith("MockRevertingERC20: transfer failed");

      // Verify state unchanged - no backfilled rounds should have been added
      expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(lastBlockRewardedBefore);
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(nextRoundIndexBefore);
    });

    it("should use regular backfill for exactly 24 skipped rounds (at threshold)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract generously
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      // Do first payout to establish baseline
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      const nextRoundIndexBefore = await PoPPayoutsV2Contract.getRoundsCount();

      // Skip exactly 24 rounds: from keystone 25 to keystone 650 = 625 blocks = 25 keystones
      // numRoundsToCalculate = (650 - 25) / 25 - 1 = 25 - 1 = 24
      const targetKeystone = 25 + (25 * 25); // 25 + 625 = 650

      // Advance time and blocks appropriately
      await time.increase(625 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(625).toString(16)]);

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        targetKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      );
      const receipt = await tx.wait();

      // Count PayoutRoundExecuted events
      const events = receipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });

      // With regular backfill: 24 skipped rounds + 1 actual round = 25 events
      expect(events?.length).to.equal(25);

      // Next round index should increase by 25 (24 backfilled + 1 actual)
      const nextRoundIndexAfter = await PoPPayoutsV2Contract.getRoundsCount();
      expect(nextRoundIndexAfter - nextRoundIndexBefore).to.equal(25n);
    });

    it("should use optimized backfill for exactly 25 skipped rounds (just over threshold)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract generously
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      // Do first payout to establish baseline
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );

      const nextRoundIndexBefore = await PoPPayoutsV2Contract.getRoundsCount();

      // Skip exactly 25 rounds: from keystone 25 to keystone 675 = 650 blocks = 26 keystones
      // numRoundsToCalculate = (675 - 25) / 25 - 1 = 26 - 1 = 25 (> 24, triggers optimized)
      const targetKeystone = 25 + (26 * 25); // 25 + 650 = 675

      // Advance time and blocks appropriately
      await time.increase(650 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(650).toString(16)]);

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        targetKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      );
      const receipt = await tx.wait();

      // Count PayoutRoundExecuted events
      const events = receipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });

      // With optimized backfill: only 13 backfilled rounds + 1 actual round = 14 events
      // (startingBackfillBlock = targetKeystone - (13 * 25))
      expect(events?.length).to.equal(14);

      // Next round index should increase by 14 (13 backfilled + 1 actual)
      const nextRoundIndexAfter = await PoPPayoutsV2Contract.getRoundsCount();
      expect(nextRoundIndexAfter - nextRoundIndexBefore).to.equal(14n);
    });

    it("should handle 100 consecutive payout rounds with verified expected values", async function () {
      this.timeout(120000); // Allow extra time for this comprehensive test

      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract generously
      const largeAmount = hre.ethers.parseUnits("100000000", 18); // 100M HEMI
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      let totalRewardsDistributed = 0n;

      // Constants for reward calculation
      const MAX_BPS = 10000n;
      const POP_REWARD_LOOKBACK = 12;
      const RETARGETING_MULTIPLIER_NO_SCORE = 10n * MAX_BPS; // 100000
      const POP_KEYSTONE_PUBLICATION_TARGET = 500000n;

      // Track round history for calculating expected rewards
      const roundHistory: { rewardPool: bigint; totalPoPScore: bigint }[] = [];

      // Helper to calculate score from heights
      const calculateScore = (heights: number[]): bigint => {
        let score = 0n;
        for (const h of heights) {
          if (h < publicationHeightScores.length) {
            score += BigInt(publicationHeightScores[h]);
          }
        }
        return score;
      };

      // Helper to calculate expected reward pool (with maximum cap)
      const calculateExpectedRewardPool = async (): Promise<bigint> => {
        if (roundHistory.length === 0) {
          return INITIAL_REWARD;
        }

        let weightedTargetAdjustedRewardPoolSum = 0n;
        let weightingSum = 0n;

        for (let lookback = 0; lookback < POP_REWARD_LOOKBACK; lookback++) {
          const roundIndex = roundHistory.length - 1 - lookback;
          if (roundIndex < 0) break;

          const round = roundHistory[roundIndex];
          let retargetingMultiplier = RETARGETING_MULTIPLIER_NO_SCORE;

          if (round.totalPoPScore > 0n) {
            retargetingMultiplier = (POP_KEYSTONE_PUBLICATION_TARGET * MAX_BPS) / round.totalPoPScore;
          }

          const targetAdjustedRewardPool = (round.rewardPool * retargetingMultiplier) / MAX_BPS;
          weightedTargetAdjustedRewardPoolSum += targetAdjustedRewardPool * BigInt(rewardLookbackWeighting[lookback]);
          weightingSum += BigInt(rewardLookbackWeighting[lookback]);
        }

        let nextRewardPool = weightedTargetAdjustedRewardPoolSum / weightingSum;

        // Cap at maximum allowed by inflation (use contract's calculation)
        const currentBlock = await hre.ethers.provider.getBlock("latest");
        const maxRewardPool = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentBlock!.timestamp);
        if (nextRewardPool > maxRewardPool) {
          nextRewardPool = maxRewardPool;
        }

        return nextRewardPool;
      };

      // Generate varied publication patterns - includes patterns above, at, and below target
      // Pattern types: 0=single(1 pub), 1=below target(3 pubs), 2=at target(5 pubs),
      // 3=above target(7 pubs), 4=high(10 pubs), 5=very high(15 pubs), 6=zero, 7=mixed heights
      const getPublicationPattern = (roundNum: number): { addresses: string[], heights: number[] } => {
        const pattern = roundNum % 10;
        const addresses: string[] = [];
        const heights: number[] = [];

        const addPubs = (count: number, heightPattern: number[]) => {
          for (let i = 0; i < count; i++) {
            addresses.push("0x" + (i + 1).toString(16).padStart(40, "0"));
            heights.push(heightPattern[i % heightPattern.length]);
          }
        };

        switch (pattern) {
          case 0: // Single optimal (100k points, 5x multiplier)
            addPubs(1, [0]);
            break;
          case 1: // 3 optimal publications (300k points, ~1.67x multiplier)
            addPubs(3, [0, 0, 0]);
            break;
          case 2: // 5 optimal publications - exactly at target (500k points, 1x multiplier)
            addPubs(5, [0, 0, 0, 0, 0]);
            break;
          case 3: // 7 optimal publications - above target (700k points, ~0.71x multiplier)
            addPubs(7, [0, 0, 0, 0, 0, 0, 0]);
            break;
          case 4: // 10 optimal publications - well above target (1M points, 0.5x multiplier)
            addPubs(10, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            break;
          case 5: // 15 optimal publications - very high (1.5M points, ~0.33x multiplier)
            addPubs(15, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            break;
          case 6: // Zero publications (10x multiplier)
            // Empty arrays
            break;
          case 7: // Mixed heights - 4 pubs at various heights (100k + 100k + 25k + 11111 = 236111 points)
            addPubs(4, [0, 1, 2, 3]);
            break;
          case 8: // 6 optimal + 2 suboptimal (600k + 50k = 650k points, ~0.77x multiplier)
            addresses.push(...Array(6).fill(0).map((_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")));
            heights.push(...[0, 0, 0, 0, 0, 0]);
            addresses.push("0x" + (7).toString(16).padStart(40, "0"));
            heights.push(2);
            addresses.push("0x" + (8).toString(16).padStart(40, "0"));
            heights.push(2);
            break;
          case 9: // 2 optimal publications (200k points, 2.5x multiplier)
            addPubs(2, [0, 0]);
            break;
        }

        return { addresses, heights };
      };

      // Get initial keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let lastKeystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Execute 100 consecutive rounds with verification
      for (let i = 0; i < 100; i++) {
        // Advance to next keystone
        const nextKeystone = lastKeystone + KEYSTONE_FREQUENCY;
        const blocksNeeded = nextKeystone - currentBlock + 10;

        await time.increase(blocksNeeded * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksNeeded).toString(16)]);

        currentBlock = await hre.ethers.provider.getBlockNumber();

        // Get publication pattern for this round
        const { addresses, heights } = getPublicationPattern(i);

        // Calculate expected values BEFORE the transaction
        const expectedRewardPool = await calculateExpectedRewardPool();
        const expectedScore = calculateScore(heights);

        // Execute the payout
        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          nextKeystone,
          addresses,
          heights
        );
        const receipt = await tx.wait();

        lastKeystone = nextKeystone;

        // Extract actual values from event
        const events = receipt?.logs.filter(log => {
          try {
            return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
          } catch { return false; }
        });

        expect(events?.length).to.equal(1, `Round ${i} should emit exactly one PayoutRoundExecuted event`);

        const parsed = PoPPayoutsV2Contract.interface.parseLog({
          topics: [...events![0].topics],
          data: events![0].data
        });
        const actualRewardPool = parsed?.args[1] as bigint;
        const actualScore = parsed?.args[2] as bigint;

        // Verify reward pool matches expected
        expect(actualRewardPool).to.equal(expectedRewardPool,
          `Round ${i}: reward pool mismatch. Expected ${expectedRewardPool}, got ${actualRewardPool}`);

        // Verify score matches expected
        expect(actualScore).to.equal(expectedScore,
          `Round ${i}: score mismatch. Expected ${expectedScore}, got ${actualScore}`);

        // Calculate actual payout: when there are publications, payout equals reward pool
        // When no publications, payout is 0
        const actualPayout = addresses.length > 0 ? actualRewardPool : 0n;

        // Update history for next round's calculation
        roundHistory.push({ rewardPool: actualRewardPool, totalPoPScore: expectedScore });
        totalRewardsDistributed += actualPayout;

        // Verify the round was stored correctly in contract
        const storedRound = await PoPPayoutsV2Contract.rounds(i);
        expect(storedRound.blockHeight).to.equal(BigInt(nextKeystone), `Round ${i}: stored blockHeight mismatch`);
        expect(storedRound.totalPoPScore).to.equal(expectedScore, `Round ${i}: stored score mismatch`);
        expect(storedRound.rewardPool).to.equal(actualRewardPool, `Round ${i}: stored rewardPool mismatch`);
      }

      // Verify final state consistency
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(100n);

      // Verify totalPoPRewards matches accumulated payouts (allow tiny rounding from pro-rata distribution)
      const contractTotalRewards = await PoPPayoutsV2Contract.totalPoPRewards();
      // Pro-rata distribution can have small rounding errors when distributing to multiple addresses
      // Allow up to 1000 wei difference over 100 rounds (10 wei per round average)
      expect(contractTotalRewards).to.be.closeTo(totalRewardsDistributed, 1000n,
        "Contract totalPoPRewards should approximately match sum of all payouts");

      // Verify reward pool stayed healthy (not near-zero) due to varied patterns
      const lastRound = await PoPPayoutsV2Contract.rounds(99);
      expect(lastRound.rewardPool).to.be.gt(INITIAL_REWARD / 10n,
        "Final reward pool should not have decayed to near-zero");

      // Balance should have decreased by exactly the rewards distributed
      const finalBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      expect(initialBalance - finalBalance).to.equal(contractTotalRewards,
        "Balance decrease should exactly match total rewards distributed");
    });

    it("should handle 75 publications (maximum) for 50 consecutive rounds with verified expected values", async function () {
      this.timeout(120000); // Increase timeout for this intensive test

      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract very generously for maximum payouts
      const veryLargeAmount = hre.ethers.parseUnits("500000000", 18); // 500M HEMI
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, veryLargeAmount);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      let totalRewardsDistributed = 0n;

      // Constants for reward calculation
      const MAX_BPS = 10000n;
      const POP_REWARD_LOOKBACK = 12;
      const POP_KEYSTONE_PUBLICATION_TARGET = 500000n;

      // Track round history for calculating expected rewards
      const roundHistory: { rewardPool: bigint; totalPoPScore: bigint }[] = [];

      // Generate 75 unique addresses
      const addresses: string[] = [];
      for (let i = 1; i <= 75; i++) {
        addresses.push("0x" + i.toString(16).padStart(40, "0"));
      }

      // Generate heights - mix of optimal and varied (cycle through 0-8)
      const heights: number[] = addresses.map((_, i) => i % 9);

      // Pre-calculate the expected score for this pattern
      // Heights cycle 0-8 for 75 publications: 75/9 = 8 complete cycles + 3 extra (0,1,2)
      // Counts: height 0=9, 1=9, 2=9, 3=8, 4=8, 5=8, 6=8, 7=8, 8=8
      const expectedScore = BigInt(
        9 * publicationHeightScores[0] +  // 9 * 100000 = 900000
        9 * publicationHeightScores[1] +  // 9 * 100000 = 900000
        9 * publicationHeightScores[2] +  // 9 * 25000 = 225000
        8 * publicationHeightScores[3] +  // 8 * 11111 = 88888
        8 * publicationHeightScores[4] +  // 8 * 6250 = 50000
        8 * publicationHeightScores[5] +  // 8 * 4000 = 32000
        8 * publicationHeightScores[6] +  // 8 * 2778 = 22224
        8 * publicationHeightScores[7] +  // 8 * 2041 = 16328
        8 * publicationHeightScores[8]    // 8 * 1563 = 12504
      ); // Total: 2,246,944 points

      // Verify our expected score calculation
      let calculatedScore = 0n;
      for (const h of heights) {
        calculatedScore += BigInt(publicationHeightScores[h]);
      }
      expect(calculatedScore).to.equal(expectedScore, "Score calculation sanity check");

      // Helper to calculate expected reward pool (with maximum cap)
      const calculateExpectedRewardPool = async (): Promise<bigint> => {
        if (roundHistory.length === 0) {
          return INITIAL_REWARD;
        }

        let weightedTargetAdjustedRewardPoolSum = 0n;
        let weightingSum = 0n;

        for (let lookback = 0; lookback < POP_REWARD_LOOKBACK; lookback++) {
          const roundIndex = roundHistory.length - 1 - lookback;
          if (roundIndex < 0) break;

          const round = roundHistory[roundIndex];
          // With 75 pubs at ~2.25M points, multiplier = 500000*10000/2246944 ≈ 2225 (0.2225x)
          const retargetingMultiplier = (POP_KEYSTONE_PUBLICATION_TARGET * MAX_BPS) / round.totalPoPScore;

          const targetAdjustedRewardPool = (round.rewardPool * retargetingMultiplier) / MAX_BPS;
          weightedTargetAdjustedRewardPoolSum += targetAdjustedRewardPool * BigInt(rewardLookbackWeighting[lookback]);
          weightingSum += BigInt(rewardLookbackWeighting[lookback]);
        }

        let nextRewardPool = weightedTargetAdjustedRewardPoolSum / weightingSum;

        // Cap at maximum allowed by inflation
        const currentBlock = await hre.ethers.provider.getBlock("latest");
        const maxRewardPool = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentBlock!.timestamp);
        if (nextRewardPool > maxRewardPool) {
          nextRewardPool = maxRewardPool;
        }

        return nextRewardPool;
      };

      // Get initial keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let lastKeystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Execute 50 rounds with maximum publications and verify each
      for (let round = 0; round < 50; round++) {
        // Advance to next keystone
        const nextKeystone = lastKeystone + KEYSTONE_FREQUENCY;
        const blocksNeeded = nextKeystone - currentBlock + 10;

        await time.increase(blocksNeeded * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksNeeded).toString(16)]);

        currentBlock = await hre.ethers.provider.getBlockNumber();

        // Calculate expected reward pool BEFORE the transaction
        const expectedRewardPool = await calculateExpectedRewardPool();

        // Execute the payout
        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          nextKeystone,
          addresses,
          heights
        );
        const receipt = await tx.wait();

        lastKeystone = nextKeystone;

        // Extract actual values from event
        const events = receipt?.logs.filter(log => {
          try {
            return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
          } catch { return false; }
        });

        expect(events?.length).to.equal(1, `Round ${round} should emit exactly one PayoutRoundExecuted event`);

        const parsed = PoPPayoutsV2Contract.interface.parseLog({
          topics: [...events![0].topics],
          data: events![0].data
        });
        const actualRewardPool = parsed?.args[1] as bigint;
        const actualScore = parsed?.args[2] as bigint;

        // Verify reward pool matches expected
        expect(actualRewardPool).to.equal(expectedRewardPool,
          `Round ${round}: reward pool mismatch. Expected ${expectedRewardPool}, got ${actualRewardPool}`);

        // Verify score matches expected (same pattern every round)
        expect(actualScore).to.equal(expectedScore,
          `Round ${round}: score mismatch. Expected ${expectedScore}, got ${actualScore}`);

        // Update history for next round's calculation
        roundHistory.push({ rewardPool: actualRewardPool, totalPoPScore: expectedScore });
        totalRewardsDistributed += actualRewardPool; // Payout equals reward pool when there are publications

        // Verify the round was stored correctly
        const storedRound = await PoPPayoutsV2Contract.rounds(round);
        expect(storedRound.blockHeight).to.equal(BigInt(nextKeystone), `Round ${round}: stored blockHeight mismatch`);
        expect(storedRound.totalPoPScore).to.equal(expectedScore, `Round ${round}: stored score mismatch`);
        expect(storedRound.rewardPool).to.equal(actualRewardPool, `Round ${round}: stored rewardPool mismatch`);
      }

      // Verify all rounds completed
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(50n);

      // Verify totalPoPRewards matches accumulated payouts (allow rounding from pro-rata distribution)
      const contractTotalRewards = await PoPPayoutsV2Contract.totalPoPRewards();
      // With 75 addresses per round over 50 rounds, rounding errors accumulate more
      // Allow up to 5000 wei difference (100 wei per round average)
      expect(contractTotalRewards).to.be.closeTo(totalRewardsDistributed, 5000n,
        "Contract totalPoPRewards should approximately match sum of all payouts");

      // With 75 publications (~2.25M points) every round, the retargeting multiplier is ~0.22x
      // This should cause reward pools to decrease significantly over time
      const firstRound = await PoPPayoutsV2Contract.rounds(0);
      const lastRound = await PoPPayoutsV2Contract.rounds(49);
      expect(lastRound.rewardPool).to.be.lt(firstRound.rewardPool,
        "Reward pool should decrease when consistently above target score");

      // Balance should have decreased by exactly the rewards distributed
      const finalBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      expect(initialBalance - finalBalance).to.equal(contractTotalRewards,
        "Balance decrease should exactly match total rewards distributed");
    });

    it("should handle extreme time gap followed by payout (1 year gap) with verified expected values", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);

      // Constants
      const MAX_BPS = 10000n;
      const POP_REWARD_LOOKBACK = 12;
      const RETARGETING_MULTIPLIER_NO_SCORE = 10n * MAX_BPS; // 100000
      const POP_KEYSTONE_PUBLICATION_TARGET = 500000n;
      const OPTIMIZED_BACKFILL_THRESHOLD = 24;

      // Do initial payout
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let firstKeystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const firstTx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        firstKeystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );
      const firstReceipt = await firstTx.wait();

      // Verify first round used INITIAL_REWARD
      const firstEvents = firstReceipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      expect(firstEvents?.length).to.equal(1);

      const firstParsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: [...firstEvents![0].topics],
        data: firstEvents![0].data
      });
      const firstRewardPool = firstParsed?.args[1] as bigint;
      const firstScore = firstParsed?.args[2] as bigint;

      // First round should use firstRoundRewards (INITIAL_REWARD = 100 HEMI)
      expect(firstRewardPool).to.equal(INITIAL_REWARD, "First round should use firstRoundRewards");
      // Single optimal publication = 100,000 points
      expect(firstScore).to.equal(BigInt(publicationHeightScores[0]), "First round score should be single optimal pub");

      const roundIndexAfterFirst = await PoPPayoutsV2Contract.getRoundsCount();
      expect(roundIndexAfterFirst).to.equal(1n);

      // Verify stored round data
      const storedFirstRound = await PoPPayoutsV2Contract.rounds(0);
      expect(storedFirstRound.blockHeight).to.equal(BigInt(firstKeystone));
      expect(storedFirstRound.rewardPool).to.equal(INITIAL_REWARD);
      expect(storedFirstRound.totalPoPScore).to.equal(BigInt(publicationHeightScores[0]));

      // Advance 1 year (extreme gap)
      const oneYearInSeconds = Math.floor(SECONDS_PER_YEAR);
      const blocksForOneYear = Math.floor(oneYearInSeconds / BLOCK_TIME_SEC);

      await time.increase(oneYearInSeconds);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksForOneYear).toString(16)]);

      // Calculate how many keystones were skipped
      currentBlock = await hre.ethers.provider.getBlockNumber();
      const secondKeystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;
      const keystonesSkipped = (secondKeystone - firstKeystone) / KEYSTONE_FREQUENCY - 1;

      // Should be way more than 24 (threshold for optimized backfill)
      // 1 year = ~105,192 keystones
      expect(keystonesSkipped).to.be.gt(OPTIMIZED_BACKFILL_THRESHOLD,
        "Should trigger optimized backfill (>24 skipped rounds)");

      // Get max reward pool at current time (will be used for backfilled rounds)
      const currentTimestamp = await time.latest();
      const maxRewardPool = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);

      // Do another payout after the 1 year gap
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        secondKeystone,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      );
      const receipt = await tx.wait();

      // Count backfilled rounds (optimized backfill should kick in)
      const payoutEvents = receipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });

      // Optimized backfill: startingBackfillBlock = keystone - (POP_REWARD_LOOKBACK * KEYSTONE_FREQUENCY)
      // Backfill loop runs from startingBackfillBlock to keystone, incrementing by KEYSTONE_FREQUENCY
      // This creates 13 backfilled rounds (indices 0-12) + 1 actual round = 14 total events
      const expectedBackfilledRounds = POP_REWARD_LOOKBACK + 2; // 14 events total
      expect(payoutEvents?.length).to.equal(expectedBackfilledRounds,
        "Optimized backfill should emit POP_REWARD_LOOKBACK + 2 events");

      // Verify backfilled rounds all use maxRewardPool (since they're skipped, zero score)
      for (let i = 0; i < payoutEvents!.length - 1; i++) {
        const parsed = PoPPayoutsV2Contract.interface.parseLog({
          topics: [...payoutEvents![i].topics],
          data: payoutEvents![i].data
        });
        const backfilledRewardPool = parsed?.args[1] as bigint;
        const backfilledScore = parsed?.args[2] as bigint;

        // All backfilled rounds should have zero score (no publications)
        expect(backfilledScore).to.equal(0n, `Backfilled round ${i} should have zero score`);
        // All backfilled rounds should use maxRewardPool
        expect(backfilledRewardPool).to.equal(maxRewardPool,
          `Backfilled round ${i} should use maxRewardPool`);
      }

      // Verify the final (actual) round
      const finalEventParsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: [...payoutEvents![payoutEvents!.length - 1].topics],
        data: payoutEvents![payoutEvents!.length - 1].data
      });
      const finalRewardPool = finalEventParsed?.args[1] as bigint;
      const finalScore = finalEventParsed?.args[2] as bigint;

      // Final round has 1 optimal publication = 100,000 points
      expect(finalScore).to.equal(BigInt(publicationHeightScores[0]),
        "Final round should have single optimal publication score");

      // Calculate expected final reward pool using weighted average of backfilled rounds
      // All 12 lookback rounds have maxRewardPool and zero score (10x multiplier)
      let weightedSum = 0n;
      let weightingSum = 0n;
      for (let lookback = 0; lookback < POP_REWARD_LOOKBACK; lookback++) {
        // All backfilled rounds have zero score, so multiplier is 10x
        const targetAdjustedRewardPool = (maxRewardPool * RETARGETING_MULTIPLIER_NO_SCORE) / MAX_BPS;
        weightedSum += targetAdjustedRewardPool * BigInt(rewardLookbackWeighting[lookback]);
        weightingSum += BigInt(rewardLookbackWeighting[lookback]);
      }
      let expectedFinalRewardPool = weightedSum / weightingSum;

      // Cap at max reward pool
      if (expectedFinalRewardPool > maxRewardPool) {
        expectedFinalRewardPool = maxRewardPool;
      }

      expect(finalRewardPool).to.equal(expectedFinalRewardPool,
        "Final round reward pool should match expected calculation");

      // Verify RoundsBackfilled event was emitted
      const backfillEvents = receipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "RoundsBackfilled";
        } catch { return false; }
      });
      expect(backfillEvents?.length).to.equal(1, "Should emit one RoundsBackfilled event");

      // Verify final state
      const finalRoundIndex = await PoPPayoutsV2Contract.getRoundsCount();
      // 1 initial round + 13 backfilled/actual rounds = 14 total
      expect(finalRoundIndex).to.equal(BigInt(1 + expectedBackfilledRounds),
        "Total rounds should be initial + backfilled + actual");

      // Verify total rewards distributed
      const totalRewards = await PoPPayoutsV2Contract.totalPoPRewards();
      // First round payout + final round payout (backfilled rounds have zero payout since zero score)
      const expectedTotalRewards = INITIAL_REWARD + finalRewardPool;
      expect(totalRewards).to.equal(expectedTotalRewards,
        "Total rewards should equal first round + final round (backfilled rounds have zero payout)");

      // Verify balance change
      const finalBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      expect(initialBalance - finalBalance).to.equal(totalRewards,
        "Balance decrease should match total rewards distributed");
    });

    it("should correctly handle reward pool calculations with maximum inflation over time with verified expected values", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Contract is already deployed with max inflation (7% yearly, 5% PoP allocation)

      // Fund contract
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      const initialBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);

      // Constants for calculations
      const YEAR_SECONDS = BigInt(Math.floor(365.25 * 24 * 60 * 60)); // 31557600
      const MAX_BPS = 10000n;
      const MINTAGE_PERIOD_SECONDS = BigInt(MINTAGE_PERIOD);

      // Advance to after several mintage periods (6 months)
      const sixMonthsInSeconds = 6 * MINTAGE_PERIOD;
      const blocksToMine = Math.floor(sixMonthsInSeconds / BLOCK_TIME_SEC);

      await time.increase(sixMonthsInSeconds);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

      // Get supply and verify it increased correctly
      const currentTimestamp = await time.latest();
      const circulatingSupply = await PoPPayoutsV2Contract.calculateCirculatingSupply(currentTimestamp);

      // Verify 6 mintage periods elapsed
      const mintagePeriodsElapsed = BigInt(Math.floor((currentTimestamp - Number(supplyTimestamp)) / MINTAGE_PERIOD));
      expect(mintagePeriodsElapsed).to.equal(6n, "Should have 6 mintage periods elapsed");

      // Verify supply increased (approximately 3.4% for 6 months of 7% yearly compounded monthly)
      const supplyIncrease = circulatingSupply - INITIAL_SUPPLY;
      const minExpectedIncrease = (INITIAL_SUPPLY * 33n) / 1000n; // ~3.3%
      const maxExpectedIncrease = (INITIAL_SUPPLY * 36n) / 1000n; // ~3.6%
      expect(supplyIncrease).to.be.gte(minExpectedIncrease, "Supply should increase by at least 3.3%");
      expect(supplyIncrease).to.be.lte(maxExpectedIncrease, "Supply increase should be at most 3.6%");

      // Calculate and verify maximum reward pool at current time
      // Formula: nextMonthPoPEmissions = (supply * popInflation * MINTAGE_PERIOD) / (YEAR * MAX_BPS)
      //          maxReward = nextMonthPoPEmissions / keystonesPerMintage
      const nextMonthPoPEmissions = (circulatingSupply * BigInt(POP_INFLATION_ALLOCATION) * MINTAGE_PERIOD_SECONDS) / (YEAR_SECONDS * MAX_BPS);
      const keystonesPerMintage = MINTAGE_PERIOD_SECONDS / BigInt(BLOCK_TIME_SEC) / BigInt(KEYSTONE_FREQUENCY);
      const expectedMaxRewardPool = nextMonthPoPEmissions / keystonesPerMintage;

      const contractMaxRewardPool = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);
      expect(contractMaxRewardPool).to.equal(expectedMaxRewardPool, "Max reward pool should match calculation");

      // After 6 months, max reward pool should be higher than initial
      const initialMaxRewardPool = await PoPPayoutsV2Contract.calculateMaximumRewardPool(supplyTimestamp);
      expect(contractMaxRewardPool).to.be.gt(initialMaxRewardPool, "Max reward pool should increase with supply");

      // Calculate expected increase in max reward pool (should be proportional to supply increase)
      const expectedMaxRewardIncrease = (initialMaxRewardPool * supplyIncrease) / INITIAL_SUPPLY;
      const actualMaxRewardIncrease = contractMaxRewardPool - initialMaxRewardPool;
      // Should be within 1% due to rounding
      expect(actualMaxRewardIncrease).to.be.closeTo(expectedMaxRewardIncrease, expectedMaxRewardIncrease / 100n,
        "Max reward pool increase should be proportional to supply increase");

      // Do first payout - should use firstRoundRewards since no rounds yet
      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const firstTx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );
      const firstReceipt = await firstTx.wait();

      // Get ALL PayoutRoundExecuted events
      // Note: First payout after deployment has no backfill (lastBlockRewarded == 0 means no gap check)
      const firstEvents = firstReceipt?.logs.filter(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });

      // First payout has no backfill - just 1 event
      expect(firstEvents?.length).to.equal(1, "First payout should have 1 event (no backfill when lastBlockRewarded == 0)");

      const firstParsed = PoPPayoutsV2Contract.interface.parseLog({
        topics: [...firstEvents![0].topics],
        data: firstEvents![0].data
      });
      const firstRewardPool = firstParsed?.args[1] as bigint;
      const firstScore = firstParsed?.args[2] as bigint;

      // First round should use firstRoundRewards
      expect(firstRewardPool).to.equal(INITIAL_REWARD, "First round should use firstRoundRewards");
      expect(firstScore).to.equal(BigInt(publicationHeightScores[0]), "First round score = single optimal pub");

      // Track total rewards
      let totalRewardsDistributed = INITIAL_REWARD;

      // Track rounds created
      let roundsCreated = 1; // First round already done

      // Do a few more consecutive rounds to verify weighted average calculation
      for (let i = 0; i < 3; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

        currentBlock = await hre.ethers.provider.getBlockNumber();
        keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

        // Use 5 optimal publications (exactly at target, 1x multiplier)
        const addresses = Array(5).fill(0).map((_, j) => "0x" + (j + 1).toString(16).padStart(40, "0"));
        const heights = Array(5).fill(0);

        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          addresses,
          heights
        );
        const receipt = await tx.wait();

        // Get all events (may include backfilled rounds due to timing)
        const events = receipt?.logs.filter(log => {
          try {
            return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
          } catch { return false; }
        });
        expect(events?.length).to.be.gte(1, `Round ${i + 2} should have at least 1 event`);
        roundsCreated += events!.length;

        // The last event is the actual round with publications
        const lastEvent = events![events!.length - 1];
        const parsed = PoPPayoutsV2Contract.interface.parseLog({
          topics: [...lastEvent.topics],
          data: lastEvent.data
        });
        const roundRewardPool = parsed?.args[1] as bigint;
        const roundScore = parsed?.args[2] as bigint;

        // Score should be 5 * 100000 = 500000 (exactly at target)
        expect(roundScore).to.equal(500000n, `Round ${i + 2} score should be 500000`);

        // Reward pool should be capped at maxRewardPool
        expect(roundRewardPool).to.be.lte(contractMaxRewardPool,
          `Round ${i + 2} reward pool should not exceed max`);

        totalRewardsDistributed += roundRewardPool;
      }

      // Verify final state
      const finalRoundCount = await PoPPayoutsV2Contract.getRoundsCount();
      expect(finalRoundCount).to.equal(BigInt(roundsCreated), "Round count should match created rounds");

      const contractTotalRewards = await PoPPayoutsV2Contract.totalPoPRewards();
      // Allow tiny rounding difference from pro-rata distribution
      expect(contractTotalRewards).to.be.closeTo(totalRewardsDistributed, 100n,
        "Contract totalPoPRewards should match accumulated payouts");

      // Verify balance decreased correctly (use closeTo for pro-rata rounding)
      const finalBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      expect(initialBalance - finalBalance).to.be.closeTo(totalRewardsDistributed, 100n,
        "Balance decrease should match rewards distributed");
    });

    it("should accumulate totalPoPRewards correctly over many rounds without overflow", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract with maximum possible amount
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      let accumulatedRewards = 0n;
      const numRounds = 50;

      // Get initial keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let lastKeystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      for (let i = 0; i < numRounds; i++) {
        // Advance to next keystone
        const nextKeystone = lastKeystone + KEYSTONE_FREQUENCY;
        const blocksNeeded = nextKeystone - currentBlock + 10;

        await time.increase(blocksNeeded * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksNeeded).toString(16)]);

        currentBlock = await hre.ethers.provider.getBlockNumber();

        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          nextKeystone,
          ["0x1111111111111111111111111111111111111111"],
          [0]
        );
        const receipt = await tx.wait();

        lastKeystone = nextKeystone;

        // Track from event
        const events = receipt?.logs.filter(log => {
          try {
            return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
          } catch { return false; }
        });

        for (const event of events || []) {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event.topics], data: event.data });
          accumulatedRewards += parsed?.args[1] || 0n;
        }
      }

      // Verify totalPoPRewards matches our accumulation
      const contractTotal = await PoPPayoutsV2Contract.totalPoPRewards();
      expect(contractTotal).to.be.closeTo(accumulatedRewards, accumulatedRewards / 100n);

      // Verify no overflow occurred (value is reasonable)
      expect(contractTotal).to.be.lt(INITIAL_PAYOUT_TOKENS);
      expect(contractTotal).to.be.gt(0n);
    });

    it("should correctly score all 75 publications at height 0 (maximum score)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract generously
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      // Generate 75 unique addresses
      const addresses: string[] = [];
      for (let i = 1; i <= 75; i++) {
        addresses.push("0x" + i.toString(16).padStart(40, "0"));
      }

      // All at height 0 (100,000 points each)
      const heights: number[] = new Array(75).fill(0);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        addresses,
        heights
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Expected score: 75 * 100,000 = 7,500,000
      expect(totalScore).to.equal(BigInt(75 * 100000));
    });

    it("should correctly score 74 publications at height 8 plus one at height 0", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract generously
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      // Generate 75 unique addresses
      const addresses: string[] = [];
      for (let i = 1; i <= 75; i++) {
        addresses.push("0x" + i.toString(16).padStart(40, "0"));
      }

      // First at height 0 (required), rest at height 8 (minimum valid score)
      const heights: number[] = [0, ...new Array(74).fill(8)];

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        addresses,
        heights
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Expected score: 1 * 100,000 + 74 * 1,563 = 100,000 + 115,662 = 215,662
      expect(totalScore).to.equal(BigInt(100000 + 74 * 1563));
    });

    it("should correctly handle height 0 vs height 8 vs height 9 (valid vs boundary vs invalid)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Test with one publication at height 0 (required), one at height 8 (boundary valid), and one at height 9 (invalid)
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        [
          "0x1111111111111111111111111111111111111111", // height 0 = 100,000 points
          "0x2222222222222222222222222222222222222222", // height 8 = 1,563 points
          "0x3333333333333333333333333333333333333333"  // height 9 = 0 points
        ],
        [0, 8, 9]
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Height 0 = 100,000, Height 8 = 1,563, Height 9 = 0
      expect(totalScore).to.equal(BigInt(100000 + 1563));

      // Check Transfer events from the HEMI token (individual payouts)
      const transferEvents = receipt?.logs.filter(log => {
        try {
          return HemiContract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "Transfer";
        } catch { return false; }
      });

      // Should have exactly 2 transfers (height 0 and height 8, not height 9)
      expect(transferEvents?.length).to.equal(2);
    });

    // Tests for "at least one publication must be at height 0" requirement
    it("should revert when all publications are at height 1 (valid score, but no height 0)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // All at height 1 - still gets 100,000 points each, but no height 0
      await expect(
        PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333"
          ],
          [1, 1, 1]
        )
      ).to.be.revertedWith("at least one of the publications must be at earliest relative height 0");
    });

    it("should revert when all publications are at height 8 (valid score, but no height 0)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // All at height 8 - minimum valid score, but no height 0
      await expect(
        PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222"
          ],
          [8, 8]
        )
      ).to.be.revertedWith("at least one of the publications must be at earliest relative height 0");
    });

    it("should revert when publications are mixed heights 1-8 (all valid scores, but no height 0)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Mix of heights 1-8 - all valid scores, but no height 0
      await expect(
        PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333",
            "0x4444444444444444444444444444444444444444"
          ],
          [1, 3, 5, 8]
        )
      ).to.be.revertedWith("at least one of the publications must be at earliest relative height 0");
    });

    it("should revert when all publications are at height 9+ (all invalid scores, no height 0)", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // All at height 9+ - all invalid scores and no height 0
      await expect(
        PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333"
          ],
          [9, 10, 100]
        )
      ).to.be.revertedWith("at least one of the publications must be at earliest relative height 0");
    });

    it("should revert when publications mix valid (1-8) and invalid (9+) heights but no height 0", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Mix of valid (1-8) and invalid (9+) heights, but no height 0
      await expect(
        PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333",
            "0x4444444444444444444444444444444444444444"
          ],
          [2, 8, 9, 15]
        )
      ).to.be.revertedWith("at least one of the publications must be at earliest relative height 0");
    });

    it("should handle duplicate addresses receiving multiple publications", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Same address appearing multiple times with different heights
      const sameAddress = "0x1111111111111111111111111111111111111111";
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        [sameAddress, sameAddress, sameAddress],
        [0, 2, 5] // 100,000 + 25,000 + 4,000 = 129,000 points
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Total score should be sum of all publications
      expect(totalScore).to.equal(BigInt(100000 + 25000 + 4000));

      // Find individual payout events (ERC20 Transfer events) - should have 3 separate payouts to same address
      const contractAddress = await PoPPayoutsV2Contract.getAddress();
      const transferEvents = receipt?.logs.filter(log => {
        try {
          const parsed = HemiContract.interface.parseLog({ topics: [...log.topics], data: log.data });
          return parsed?.name === "Transfer" && parsed?.args[0] === contractAddress;
        } catch { return false; }
      });

      // Each publication is a separate payout (3 transfers to the same address)
      expect(transferEvents?.length).to.equal(3);
    });

    it("should correctly score each valid height (0-8) with expected points", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // One publication at each valid height
      const addresses: string[] = [];
      for (let i = 0; i < 9; i++) {
        addresses.push("0x" + (i + 1).toString(16).padStart(40, "0"));
      }

      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        addresses,
        [0, 1, 2, 3, 4, 5, 6, 7, 8]
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Expected total: 100000 + 100000 + 25000 + 11111 + 6250 + 4000 + 2778 + 2041 + 1563 = 252743
      const expectedTotal = publicationHeightScores.reduce((a, b) => a + b, 0);
      expect(totalScore).to.equal(BigInt(expectedTotal));
    });

    it("should verify reward distribution is proportional to scores", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Two publications: one at height 0 (100,000), one at height 2 (25,000)
      // Ratio should be 4:1
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222"
        ],
        [0, 2]
      );
      const receipt = await tx.wait();

      // Find individual payout events (ERC20 Transfer events)
      const contractAddress = await PoPPayoutsV2Contract.getAddress();
      const transferEvents = receipt?.logs.filter(log => {
        try {
          const parsed = HemiContract.interface.parseLog({ topics: [...log.topics], data: log.data });
          return parsed?.name === "Transfer" && parsed?.args[0] === contractAddress;
        } catch { return false; }
      }).map(log => HemiContract.interface.parseLog({ topics: [...log.topics], data: log.data }));

      expect(transferEvents.length).to.equal(2);

      // Transfer event args: from, to, value
      const payout1 = transferEvents[0]?.args[2]; // amount for height 0
      const payout2 = transferEvents[1]?.args[2]; // amount for height 2

      // Ratio should be approximately 100,000 : 25,000 = 4:1
      // Allow small tolerance for rounding
      const ratio = (payout1 * 100n) / payout2;
      expect(ratio).to.be.gte(395n); // ~3.95:1
      expect(ratio).to.be.lte(405n); // ~4.05:1
    });

    it("should handle mixed valid and invalid heights correctly", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Mix of valid (0, 4, 8) and invalid (9, 15, 100) heights
      const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        [
          "0x1111111111111111111111111111111111111111", // height 0 = 100,000
          "0x2222222222222222222222222222222222222222", // height 9 = 0
          "0x3333333333333333333333333333333333333333", // height 4 = 6,250
          "0x4444444444444444444444444444444444444444", // height 15 = 0
          "0x5555555555555555555555555555555555555555", // height 8 = 1,563
          "0x6666666666666666666666666666666666666666"  // height 100 = 0
        ],
        [0, 9, 4, 15, 8, 100]
      );
      const receipt = await tx.wait();

      // Find the PayoutRoundExecuted event
      const event = receipt?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const totalScore = parsed?.args[2];

      // Only valid heights contribute: 100,000 + 6,250 + 1,563 = 107,813
      expect(totalScore).to.equal(BigInt(100000 + 6250 + 1563));

      // Find individual payout events (ERC20 Transfer events) - only 3 valid publications get paid
      const contractAddress = await PoPPayoutsV2Contract.getAddress();
      const transferEvents = receipt?.logs.filter(log => {
        try {
          const parsed = HemiContract.interface.parseLog({ topics: [...log.topics], data: log.data });
          return parsed?.name === "Transfer" && parsed?.args[0] === contractAddress;
        } catch { return false; }
      });

      expect(transferEvents?.length).to.equal(3);
    });

    it("should store and return correct PayoutRound data in rounds array", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time and get keystone
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Execute payout with known publications
      const addresses = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222"
      ];
      const heights = [0, 2]; // 100,000 + 25,000 = 125,000 points

      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystone,
        addresses,
        heights
      );

      // Query rounds(0) directly
      const round = await PoPPayoutsV2Contract.rounds(0);

      // Verify PayoutRound struct data
      expect(round.blockHeight).to.equal(keystone);
      expect(round.totalPoPScore).to.equal(BigInt(100000 + 25000)); // 125,000 points
      expect(round.rewardPool).to.equal(INITIAL_REWARD); // First round uses firstRoundRewards
    });

    it("should store multiple rounds correctly and allow indexed access", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract generously
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Advance time
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      let currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      // Execute 5 rounds
      const keystones: number[] = [];
      for (let i = 0; i < 5; i++) {
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone,
          ["0x1111111111111111111111111111111111111111"],
          [0]
        );
        keystones.push(keystone);

        // Advance to next keystone
        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

        keystone += KEYSTONE_FREQUENCY;
      }

      // Verify each round is accessible and has correct blockHeight
      for (let i = 0; i < 5; i++) {
        const round = await PoPPayoutsV2Contract.rounds(i);
        expect(round.blockHeight).to.equal(keystones[i]);
        expect(round.totalPoPScore).to.equal(BigInt(100000)); // Single height 0 publication
      }
    });

    it("should maintain monotonically increasing blockHeight in rounds array", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      const addresses = [PROTOCOL_ADDRESS];
      const heights = [0];

      // Execute multiple rounds with varying gaps
      const keystones = [25, 50, 100, 125, 175, 200];

      for (const keystone of keystones) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // Advance to the target keystone
        const currentBlock = BigInt(await hre.network.provider.send("eth_blockNumber", []));
        if (currentBlock < keystone) {
          const blocksNeeded = Number(BigInt(keystone) - currentBlock);
          await hre.network.provider.send("hardhat_mine", ["0x" + blocksNeeded.toString(16)]);
          await time.increase(blocksNeeded * 12);
        }

        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone, addresses, heights
        );
      }

      // Verify monotonic increase invariant
      const roundsCount = await PoPPayoutsV2Contract.getRoundsCount();
      let previousBlockHeight = 0n;

      for (let i = 0; i < roundsCount; i++) {
        const round = await PoPPayoutsV2Contract.rounds(i);
        expect(round.blockHeight).to.be.gt(previousBlockHeight,
          `Round ${i} blockHeight (${round.blockHeight}) should be > previous (${previousBlockHeight})`);
        previousBlockHeight = round.blockHeight;
      }
    });

    it("should never pay out more than the reward pool per round", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund contract with large amount to handle many rounds
      const largeBalance = INITIAL_PAYOUT_TOKENS * 100n;
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeBalance);

      // Helper to generate addresses
      const genAddresses = (count: number) => Array(count).fill(PROTOCOL_ADDRESS);

      // Helper to generate heights with at least one 0
      const genHeights = (count: number, pattern: 'all0' | 'all8' | 'sequential' | 'random' | 'mixed') => {
        const heights: number[] = [];
        for (let i = 0; i < count; i++) {
          switch (pattern) {
            case 'all0':
              heights.push(0);
              break;
            case 'all8':
              heights.push(i === 0 ? 0 : 8); // First must be 0
              break;
            case 'sequential':
              heights.push(i === 0 ? 0 : Math.min(i % 9, 8));
              break;
            case 'random':
              heights.push(i === 0 ? 0 : Math.floor(Math.random() * 9));
              break;
            case 'mixed':
              // Mix of low and high heights
              heights.push(i === 0 ? 0 : (i % 3 === 0 ? 8 : i % 9));
              break;
          }
        }
        return heights;
      };

      // Comprehensive test cases covering many scenarios
      const testCases: { addresses: string[], heights: number[], description: string }[] = [
        // Single publication
        { addresses: genAddresses(1), heights: [0], description: "1 pub at height 0" },

        // Small counts with various patterns
        { addresses: genAddresses(2), heights: [0, 0], description: "2 pubs all at height 0" },
        { addresses: genAddresses(2), heights: [0, 8], description: "2 pubs at heights 0 and 8" },
        { addresses: genAddresses(3), heights: [0, 4, 8], description: "3 pubs spread across heights" },
        { addresses: genAddresses(5), heights: genHeights(5, 'all0'), description: "5 pubs all at height 0" },
        { addresses: genAddresses(5), heights: genHeights(5, 'sequential'), description: "5 pubs sequential heights" },

        // Medium counts
        { addresses: genAddresses(10), heights: genHeights(10, 'all0'), description: "10 pubs all at height 0" },
        { addresses: genAddresses(10), heights: genHeights(10, 'all8'), description: "10 pubs mostly at height 8" },
        { addresses: genAddresses(10), heights: genHeights(10, 'sequential'), description: "10 pubs sequential" },
        { addresses: genAddresses(10), heights: genHeights(10, 'mixed'), description: "10 pubs mixed heights" },
        { addresses: genAddresses(15), heights: genHeights(15, 'random'), description: "15 pubs random heights" },
        { addresses: genAddresses(20), heights: genHeights(20, 'all0'), description: "20 pubs all at height 0" },
        { addresses: genAddresses(25), heights: genHeights(25, 'mixed'), description: "25 pubs mixed heights" },

        // Larger counts approaching maximum
        { addresses: genAddresses(50), heights: genHeights(50, 'all0'), description: "50 pubs all at height 0" },
        { addresses: genAddresses(50), heights: genHeights(50, 'all8'), description: "50 pubs mostly at height 8" },
        { addresses: genAddresses(50), heights: genHeights(50, 'random'), description: "50 pubs random heights" },

        // Maximum publications (75)
        { addresses: genAddresses(75), heights: genHeights(75, 'all0'), description: "75 pubs (max) all at height 0" },
        { addresses: genAddresses(75), heights: genHeights(75, 'all8'), description: "75 pubs (max) mostly at height 8" },
        { addresses: genAddresses(75), heights: genHeights(75, 'sequential'), description: "75 pubs (max) sequential" },
        { addresses: genAddresses(75), heights: genHeights(75, 'random'), description: "75 pubs (max) random" },
        { addresses: genAddresses(75), heights: genHeights(75, 'mixed'), description: "75 pubs (max) mixed" },

        // Edge case: many duplicates at same height
        { addresses: genAddresses(30), heights: Array(30).fill(0), description: "30 pubs all duplicates at 0" },

        // Edge case: worst case scoring (all at height 8 except one at 0)
        { addresses: genAddresses(75), heights: [0, ...Array(74).fill(8)], description: "75 pubs worst scoring (74 at h8)" },

        // Prime numbers of publications (to test rounding)
        { addresses: genAddresses(7), heights: genHeights(7, 'random'), description: "7 pubs (prime) random" },
        { addresses: genAddresses(11), heights: genHeights(11, 'random'), description: "11 pubs (prime) random" },
        { addresses: genAddresses(13), heights: genHeights(13, 'mixed'), description: "13 pubs (prime) mixed" },
        { addresses: genAddresses(17), heights: genHeights(17, 'sequential'), description: "17 pubs (prime) sequential" },
        { addresses: genAddresses(23), heights: genHeights(23, 'random'), description: "23 pubs (prime) random" },
        { addresses: genAddresses(37), heights: genHeights(37, 'mixed'), description: "37 pubs (prime) mixed" },
        { addresses: genAddresses(41), heights: genHeights(41, 'random'), description: "41 pubs (prime) random" },
        { addresses: genAddresses(73), heights: genHeights(73, 'random'), description: "73 pubs (prime) random" },
      ];

      let keystone = 25;
      let roundsExecuted = 0;

      for (const testCase of testCases) {
        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

        const balanceBefore = await HemiContract.balanceOf(PoPPayoutsV2Contract);

        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystone, testCase.addresses, testCase.heights
        );

        const receipt = await tx.wait();

        // Extract rewardPool from PayoutRoundExecuted event
        const payoutEvent = receipt?.logs.find(
          (log: any) => log.fragment?.name === "PayoutRoundExecuted"
        );

        expect(payoutEvent, `PayoutRoundExecuted event not found for: ${testCase.description}`).to.exist;

        if (payoutEvent && 'args' in payoutEvent) {
          const rewardPool = payoutEvent.args[1];
          const balanceAfter = await HemiContract.balanceOf(PoPPayoutsV2Contract);
          const actualPaid = balanceBefore - balanceAfter;

          // Primary invariant: actualPaid <= rewardPool
          expect(actualPaid).to.be.lte(rewardPool,
            `INVARIANT VIOLATION [${testCase.description}]: Paid ${actualPaid} exceeds rewardPool ${rewardPool}`);

          // Secondary check: actualPaid should be > 0 for non-empty publication lists
          expect(actualPaid).to.be.gt(0n,
            `[${testCase.description}]: No tokens paid despite ${testCase.addresses.length} publications`);

          // Tertiary check: reward pool should be positive
          expect(rewardPool).to.be.gt(0n,
            `[${testCase.description}]: Reward pool is zero`);
        }

        keystone += KEYSTONE_FREQUENCY;
        roundsExecuted++;
      }

      // Verify we actually tested all cases
      expect(roundsExecuted).to.equal(testCases.length,
        `Expected ${testCases.length} rounds but only executed ${roundsExecuted}`);
    });

    it("should revert calculateMaximumRewardPool at supplyTimestamp - 1 second", async function () {
      const { PoPPayoutsV2Contract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // At supplyTimestamp - 1, contract should revert
      await expect(PoPPayoutsV2Contract.calculateMaximumRewardPool(supplyTimestamp - 1))
        .to.be.revertedWith("time cannot be below the supply timestamp");
    });

    describe("Gas Consumption", function () {
      itCoverageDisabled("100 round payouts with 75 publications should never consume more than 4M gas per invocation", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        var rounds = 100;

        var signer = await protocolSigner;
        for (let i = 0; i < rounds; i++) {
          // Random heights between 0 and 8 at each loop
          const heights: number[] = Array.from({ length: 75 }, () => Math.floor(Math.random() * 9));

          // Make sure there is always one zero
          heights[15] = 0;

          await time.increase(25 * 12);
          await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

          const gas = await measureGas(() =>
            PoPPayoutsV2Contract.connect(signer).mintPoPRewards(((i+1) * 25), addresses, heights)
          );
          expect(gas).to.be.lt(4000000);
        }
      });
      itCoverageDisabled("100 round payouts with 16 publications should never consume more than 700K gas per invocation", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const addresses: string[] = [
          "0xf100000000000000000000000000000000000001",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000003",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf100000000000000000000000000000000000005",
          "0xf100000000000000000000000000000000000006",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000008",
          "0xf100000000000000000000000000000000000009",
          "0xf10000000000000000000000000000000000000a",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf10000000000000000000000000000000000000c",
          "0xf10000000000000000000000000000000000000d",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf10000000000000000000000000000000000000f",
          "0xf100000000000000000000000000000000000010",
        ];

        var rounds = 100;

        var signer = await protocolSigner;
        for (let i = 0; i < rounds; i++) {
          // Random heights between 0 and 8 at each loop
          const heights: number[] = Array.from({ length: 16 }, () => Math.floor(Math.random() * 9));

          // Make sure there is always one zero
          heights[5] = 0;

          await time.increase(25 * 12);
          await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

          const gas = await measureGas(() =>
            PoPPayoutsV2Contract.connect(signer).mintPoPRewards(((i+1) * 25), addresses, heights)
          );
          expect(gas).to.be.lt(700000);
        }
      });
      itCoverageDisabled("23 skipped rounds after the first round should consume less than 4M gas", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        const heights: number[] = Array.from({ length: 75 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 23;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + (keystonesToSkip + 1) * 25), addresses, heights)
        );
        expect(gas).to.be.lt(4000000);
      });
      itCoverageDisabled("24 skipped rounds after the first round should consume less than 4M gas", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        const heights: number[] = Array.from({ length: 75 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 24;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + (keystonesToSkip + 1) * 25), addresses, heights)
        );
        expect(gas).to.be.lt(4000000);
      });
      itCoverageDisabled("25 skipped rounds after the first round should consume less than 3M gas", async function () {
        // >24 skipped rounds means the standard backfill should apply
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        const heights: number[] = Array.from({ length: 75 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 25;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + (keystonesToSkip + 1) * 25), addresses, heights)
        );
        expect(gas).to.be.lt(3000000);
      });
      itCoverageDisabled("26 skipped rounds after the first round should consume less than 3M gas", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        const heights: number[] = Array.from({ length: 75 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 26;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + (keystonesToSkip + 1) * 25), addresses, heights)
        );
        expect(gas).to.be.lt(3000000);
      });

      itCoverageDisabled("100 skipped rounds after the first round should consume less than 3M gas", async function () {
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const addresses: string[] = [
          "0xf100000000000000000000000000000000000001",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000003",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf100000000000000000000000000000000000005",
          "0xf100000000000000000000000000000000000006",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000008",
          "0xf100000000000000000000000000000000000009",
          "0xf10000000000000000000000000000000000000a",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf10000000000000000000000000000000000000c",
          "0xf10000000000000000000000000000000000000d",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf10000000000000000000000000000000000000f",
          "0xf100000000000000000000000000000000000010",
        ];

        const heights: number[] = Array.from({ length: 16 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 100;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const targetFutureTimestamp = await time.latest() + (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(targetFutureTimestamp);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + (keystonesToSkip + 1) * 25), addresses, heights)
        );
        expect(gas).to.be.lt(3000000);
      });

      itCoverageDisabled("1 million skipped rounds after the first round should consume less than 3M gas", async function () {
        // No matter how many skipped rounds exist, above a threshold of 24 only the past 12 will be calculated,
        // so gas should not scale with how many rounds are skipped
        const { PoPPayoutsV2Contract, supplyOwner, owner, HemiContract, hemiTokenOwner, initialMintReceiver, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

        await expect(HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS
        )).to.emit(HemiContract, "Transfer").withArgs(initialMintReceiver.address, PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(INITIAL_PAYOUT_TOKENS);

        const addresses: string[] = [
          "0xf100000000000000000000000000000000000001",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000003",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf100000000000000000000000000000000000005",
          "0xf100000000000000000000000000000000000006",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf100000000000000000000000000000000000008",
          "0xf100000000000000000000000000000000000009",
          "0xf10000000000000000000000000000000000000a",
          "0xf100000000000000000000000000000000000002", // Duplicate x3
          "0xf10000000000000000000000000000000000000c",
          "0xf10000000000000000000000000000000000000d",
          "0xf10000000000000000000000000000000000000e", // Duplicate x2
          "0xf10000000000000000000000000000000000000f",
          "0xf100000000000000000000000000000000000010",
        ];

        const heights: number[] = Array.from({ length: 16 }, () => Math.floor(Math.random() * 9));

        // Make sure there is always one zero
        heights[7] = 0;

        await time.increase((25 * 11));
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        // First round should pay out initial reward
        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          (25), addresses, heights
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");

        const keystonesToSkip = 1000000;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const targetFutureTimestamp = await time.latest() + (blocksToMine * 12);

        // Increase time as expected based on missed keystone progression so calculation of past round
        // timestamps doesn't underflow
        await time.increase(targetFutureTimestamp);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const height = await hre.ethers.provider.getBlockNumber();

        var signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards((25 + keystonesToSkip*25 + 25), addresses, heights)
        );
        expect(gas).to.be.lt(3000000);
      });

      // The 5M gas limit ensures that even worst-case scenarios fit within reasonable block gas limits
      const MAX_GAS_LIMIT = 5000000;

      itCoverageDisabled("first call with 75 publications (cold storage) should be under 5M gas", async function () {
        // This tests the absolute worst case for a first call:
        // - Cold storage access for all state variables
        // - Maximum 75 publications
        // - First round initialization
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);
        // Use various heights to test all code paths in the loop
        const heights = Array.from({ length: 75 }, (_, i) => i % 9);
        heights[0] = 0; // Ensure at least one height 0

        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        const signer = await protocolSigner;
        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(25, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("75 publications + 24 skipped rounds (max regular backfill) should be under 5M gas", async function () {
        // This tests: max publications + maximum regular backfill (24 rounds)
        // Regular backfill happens when numRoundsToCalculate <= MAXIMUM_SKIPPED_ROUND_RECALCULATION (24)
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        // First call to initialize state
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        await PoPPayoutsV2Contract.connect(signer).mintPoPRewards(25, [], []);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);
        const heights = Array.from({ length: 75 }, (_, i) => i % 9);
        heights[0] = 0;

        // Skip 24 keystones (the maximum before optimized backfill kicks in)
        const keystonesToSkip = 24;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = blocksToMine * 12;

        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const targetKeystone = 25 + (keystonesToSkip + 1) * 25;

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(targetKeystone, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("75 publications + 25 skipped rounds (optimized backfill) should be under 5M gas", async function () {
        // This tests: max publications + optimized backfill (>24 rounds triggers the optimized path)
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        // First call to initialize state
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        await PoPPayoutsV2Contract.connect(signer).mintPoPRewards(25, [], []);

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);
        const heights = Array.from({ length: 75 }, (_, i) => i % 9);
        heights[0] = 0;

        // Skip 25 keystones (triggers optimized backfill)
        const keystonesToSkip = 25;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = blocksToMine * 12;

        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const targetKeystone = 25 + (keystonesToSkip + 1) * 25;

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(targetKeystone, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("75 publications after 12 rounds of history (full lookback) should be under 5M gas", async function () {
        // This tests: max publications with full reward lookback history (12 rounds)
        // This is the steady-state worst case for normal operations
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        // Build up 12 rounds of history first
        for (let i = 0; i < 12; i++) {
          const heights = Array.from({ length: 10 }, (_, j) => j % 9);
          heights[0] = 0;
          const smallAddresses = addresses.slice(0, 10);

          await time.increase(25 * 12);
          await hre.network.provider.send("hardhat_mine", ["0x19"]);
          await PoPPayoutsV2Contract.connect(signer).mintPoPRewards(
            (i + 1) * 25, smallAddresses, heights
          );
        }

        // Now test with 75 publications
        const heights = Array.from({ length: 75 }, (_, i) => i % 9);
        heights[0] = 0;

        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(13 * 25, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("75 publications + 24 skipped rounds after 12 rounds of history should be under 5M gas", async function () {
        // This is the ultimate worst case: full history + max backfill + max publications
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        // Build up 12 rounds of history first
        for (let i = 0; i < 12; i++) {
          const heights = Array.from({ length: 5 }, (_, j) => j % 9);
          heights[0] = 0;
          const smallAddresses = addresses.slice(0, 5);

          await time.increase(25 * 12);
          await hre.network.provider.send("hardhat_mine", ["0x19"]);
          await PoPPayoutsV2Contract.connect(signer).mintPoPRewards(
            (i + 1) * 25, smallAddresses, heights
          );
        }

        // Skip 24 keystones (max regular backfill)
        const keystonesToSkip = 24;
        const blocksToMine = (keystonesToSkip + 1) * 25;
        const timeDelta = blocksToMine * 12;

        await time.increase(timeDelta);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

        const targetKeystone = 12 * 25 + (keystonesToSkip + 1) * 25;

        // Now test with 75 publications
        const heights = Array.from({ length: 75 }, (_, i) => i % 9);
        heights[0] = 0;

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(targetKeystone, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("all publications at height 0 (maximum points per publication)", async function () {
        // Test with all publications at height 0 for maximum points calculation
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);
        // All at height 0 - maximum 100,000 points each
        const heights = Array.from({ length: 75 }, () => 0);

        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(25, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("mix of valid and invalid publication heights (some >= 9)", async function () {
        // Test with some publications that won't receive rewards (height >= 9)
        // This tests the branching behavior in the loops
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

        const signer = await protocolSigner;

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);
        // Mix of valid (0-8) and invalid (9+) heights
        const heights = Array.from({ length: 75 }, (_, i) => {
          if (i === 0) return 0; // Ensure at least one 0
          if (i % 3 === 0) return 9 + (i % 10); // Some invalid heights
          return i % 9; // Valid heights
        });

        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);

        const gas = await measureGas(() =>
          PoPPayoutsV2Contract.connect(signer).mintPoPRewards(25, addresses, heights)
        );

        expect(gas).to.be.lt(MAX_GAS_LIMIT);
      });

      itCoverageDisabled("sustained 75 publication load for 50 rounds should stay under 5M gas", async function () {
        // Test sustained worst-case load over many rounds
        const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

        await HemiContract.connect(initialMintReceiver).transfer(
          PoPPayoutsV2Contract,
          hre.ethers.parseUnits("100000000", 18) // 100M tokens for sustained payouts
        );

        const signer = await protocolSigner;

        const wallets = Array.from({ length: 75 }, () => hre.ethers.Wallet.createRandom());
        const addresses = wallets.map(w => w.address);

        const rounds = 50;
        let maxGas = 0n;

        for (let i = 0; i < rounds; i++) {
          const heights = Array.from({ length: 75 }, (_, j) => j % 9);
          heights[0] = 0;

          await time.increase(25 * 12);
          await hre.network.provider.send("hardhat_mine", ["0x19"]);

          const gas = await measureGas(() =>
            PoPPayoutsV2Contract.connect(signer).mintPoPRewards(
              (i + 1) * 25, addresses, heights
            )
          );

          if (gas > maxGas) {
            maxGas = gas;
          }
          expect(gas).to.be.lt(MAX_GAS_LIMIT);
        }
      });
    });
  });

  describe("FastPow Math", function () {
    async function deployHarnessContract() {
      const { HemiContract, hemiTokenOwner, initialMintReceiver } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner, random1, random2 } = await getAddresses();

      const now = await time.latest();
      await time.increaseTo(now + 1);

      const PoPPayoutsV2HarnessFactory = await hre.ethers.getContractFactory("PoPPayoutsV2Harness");
      const HarnessContract = await PoPPayoutsV2HarnessFactory.deploy();
      await HarnessContract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      return { HarnessContract };
    }

    it("fastPow with exponent 0 should return scale", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      const scale = hre.ethers.parseUnits("1", 18);

      // num^0 = 1 (which is scale in scaled representation)
      expect(await HarnessContract.exposedFastPow(12345, 0, scale)).to.equal(scale);
      expect(await HarnessContract.exposedFastPow(0, 0, scale)).to.equal(scale);
      expect(await HarnessContract.exposedFastPow(hre.ethers.parseUnits("1", 18), 0, scale)).to.equal(scale);

      // Different scales
      expect(await HarnessContract.exposedFastPow(999, 0, 1000)).to.equal(1000);
      expect(await HarnessContract.exposedFastPow(999, 0, 1)).to.equal(1);
    });

    it("fastPow with exponent 1 should return num", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      const scale = hre.ethers.parseUnits("1", 18);

      // num^1 = num
      expect(await HarnessContract.exposedFastPow(scale, 1, scale)).to.equal(scale);
      expect(await HarnessContract.exposedFastPow(scale * 2n, 1, scale)).to.equal(scale * 2n);
      expect(await HarnessContract.exposedFastPow(scale / 2n, 1, scale)).to.equal(scale / 2n);
    });

    it("fastPow with exponent 2 should return num squared", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      const scale = hre.ethers.parseUnits("1", 18);

      // (1.0)^2 = 1.0
      expect(await HarnessContract.exposedFastPow(scale, 2, scale)).to.equal(scale);

      // (2.0)^2 = 4.0
      expect(await HarnessContract.exposedFastPow(scale * 2n, 2, scale)).to.equal(scale * 4n);

      // (0.5)^2 = 0.25
      expect(await HarnessContract.exposedFastPow(scale / 2n, 2, scale)).to.equal(scale / 4n);
    });

    it("fastPow with larger exponents should calculate correctly", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      const scale = hre.ethers.parseUnits("1", 18);

      // (1.0)^10 = 1.0
      expect(await HarnessContract.exposedFastPow(scale, 10, scale)).to.equal(scale);

      // (2.0)^10 = 1024.0
      expect(await HarnessContract.exposedFastPow(scale * 2n, 10, scale)).to.equal(scale * 1024n);

      // (1.5)^3 = 3.375 (with some precision loss)
      const onePointFive = scale * 3n / 2n; // 1.5 in scaled form
      const result = await HarnessContract.exposedFastPow(onePointFive, 3, scale);
      const expected = scale * 27n / 8n; // 3.375 in scaled form
      // Allow small precision difference
      expect(result).to.be.closeTo(expected, scale / 1000n);
    });

    it("fastPow with scale 0 should revert", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      await expect(HarnessContract.exposedFastPow(100, 2, 0))
        .to.be.revertedWith("scale cannot be zero");
    });

    it("fastPow should match expected inflation calculation", async function () {
      const { HarnessContract } = await loadFixture(deployHarnessContract);

      // This tests the actual use case: monthly compound inflation
      // Monthly factor for 7% yearly inflation: (1.07)^(1/12) ≈ 1.00565415
      const scale = hre.ethers.parseUnits("1", 18);
      const monthlyFactor = 1005654150000000000n; // ~1.00565415 in 18 decimals

      // After 12 months, should be close to 1.07
      const result = await HarnessContract.exposedFastPow(monthlyFactor, 12, scale);
      const expectedYearlyFactor = scale * 107n / 100n; // 1.07

      // Allow 0.01% precision difference due to rounding
      const tolerance = scale / 10000n;
      expect(result).to.be.closeTo(expectedYearlyFactor, tolerance);
    });

    it("should handle fastPow with maximum exponent (1200 months = 100 years)", async function () {
      const { PoPPayoutsV2Contract, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Advance to 100 years in the future
      const hundredYearsInSeconds = Math.floor(100 * SECONDS_PER_YEAR);
      const blocksToMine = Math.floor(hundredYearsInSeconds / BLOCK_TIME_SEC);

      await time.increase(hundredYearsInSeconds);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToMine).toString(16)]);

      // This will internally call fastPow with exponent = 1200 (100 years * 12 months)
      const supply = await PoPPayoutsV2Contract.calculateCirculatingSupply(supplyTimestamp + hundredYearsInSeconds);

      // Verify the calculation completed without overflow
      expect(supply).to.be.gt(INITIAL_SUPPLY);
      expect(supply).to.be.lt(ERC20_MAX_SUPPLY);
    });
  });

  /**
   * Reentrancy Protection Tests
   *
   * These tests verify the nonReentrant modifier correctly prevents reentrancy attacks.
   *
   * For withdrawFunds/withdrawETH: The nonReentrant modifier is the primary reentrancy
   * protection and is directly exercised by these tests.
   *
   * For mintPoPRewards: Two layers of protection exist:
   *   1. onlyDepositor - blocks calls from anyone except DEPOSITOR_ACCOUNT (0x888...888)
   *   2. nonReentrant  - blocks reentrant calls even from the depositor
   *
   * In practice, the nonReentrant modifier on mintPoPRewards is UNREACHABLE because:
   *   - DEPOSITOR_ACCOUNT is a constant address (0x8888888888888888888888888888888888888888)
   *   - No contract can be deployed at this address in production (it's protocol-controlled)
   *   - Any reentrancy attempt from a malicious token fails onlyDepositor before nonReentrant
   *
   * We test nonReentrant on mintPoPRewards using hardhat_setCode (which bypasses normal
   * deployment) to verify the modifier works correctly as defense-in-depth, even though
   * this scenario cannot occur in production.
   */
  describe("Reentrancy Protection", function () {
    // Tests nonReentrant on withdrawFunds via malicious ERC20 callback
    it("withdrawFunds should block reentrancy attempts", async function () {
      const { PoPPayoutsV2Contract, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy malicious ERC20 that attempts reentrancy during transfer
      const MaliciousERC20Factory = await hre.ethers.getContractFactory("MaliciousReentrantERC20");
      const MaliciousERC20 = await MaliciousERC20Factory.deploy(
        PoPPayoutsV2Contract, // Mint tokens directly to the payout contract
        hre.ethers.parseUnits("10000", 18)
      );

      expect(await MaliciousERC20.balanceOf(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseUnits("10000", 18));

      // Configure the attack: when transfer is called, try to call withdrawFunds again
      await MaliciousERC20.setAttackParams(
        PoPPayoutsV2Contract,
        random1.address,
        hre.ethers.parseUnits("100", 18)
      );

      // Call withdrawFunds - this will trigger the malicious token's transfer,
      // which will attempt to reenter withdrawFunds
      // The nonReentrant modifier should block the reentrancy attempt
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        MaliciousERC20,
        hre.ethers.parseUnits("500", 18),
        random1.address
      )).to.emit(MaliciousERC20, "ReentrancyAttempted");

      // Verify the attack was attempted
      expect(await MaliciousERC20.attackAttempted()).to.equal(true);

      // The original transfer should have succeeded (only the reentrant call should fail)
      expect(await MaliciousERC20.balanceOf(random1.address)).to.equal(hre.ethers.parseUnits("500", 18));

      // Get the event to verify the reentrancy was blocked with the expected error
      const filter = MaliciousERC20.filters.ReentrancyAttempted();
      const events = await MaliciousERC20.queryFilter(filter);
      expect(events.length).to.equal(1);
      expect(events[0].args.success).to.equal(false);
      // The returnData should contain the revert reason from ReentrancyGuard
      const returnData = events[0].args.returnData;
      expect(returnData).to.not.equal("0x");
    });

    // Tests that malicious token reentrancy is blocked by onlyDepositor (not nonReentrant).
    // The token's callback has msg.sender as the token contract address, which fails onlyDepositor.
    it("mintPoPRewards should block reentrancy attempts from malicious tokens (via onlyDepositor)", async function () {
      const { supplyOwner, owner } = await getAddresses();

      // Deploy malicious Hemi token that attempts reentrancy during transfer
      const MaliciousHemiFactory = await hre.ethers.getContractFactory("MaliciousReentrantHemi");
      const initialSupply = hre.ethers.parseUnits("1000000000", 18);
      const MaliciousHemi = await MaliciousHemiFactory.deploy(
        owner.address, // Initial receiver
        initialSupply
      );

      const now = await time.latest();
      await time.increaseTo(now + 1);

      // Deploy PoPPayoutsV2 with the malicious Hemi token
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2WithMaliciousToken = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2WithMaliciousToken.initialize(
        owner.address,
        supplyOwner.address,
        MaliciousHemi,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      // Transfer tokens to the payout contract
      await MaliciousHemi.connect(owner).transfer(
        PoPPayoutsV2WithMaliciousToken,
        hre.ethers.parseUnits("100000", 18)
      );

      // Mine some blocks to get past the keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      const keystoneHeight = 50;

      // Configure the attack: when transfer is called during reward distribution,
      // try to call mintPoPRewards again with a different keystone
      await MaliciousHemi.setAttackParams(
        await PoPPayoutsV2WithMaliciousToken.getAddress(),
        BigInt(keystoneHeight + 25) // Try to reward the next keystone
      );

      const addresses = ["0x1111111111111111111111111111111111111111"];
      const heights = [0];

      // Call mintPoPRewards from the protocol address.
      // During token transfer, the malicious token attempts to reenter mintPoPRewards.
      // This fails with onlyDepositor since msg.sender is the token contract, not the depositor.
      await expect(PoPPayoutsV2WithMaliciousToken.connect(await protocolSigner).mintPoPRewards(
        keystoneHeight,
        addresses,
        heights.map(h => h)
      )).to.emit(MaliciousHemi, "ReentrancyAttempted");

      // Verify the attack was attempted but reentrancy did not succeed
      expect(await MaliciousHemi.attackAttempted()).to.equal(true);
      expect(await MaliciousHemi.reentrancySucceeded()).to.equal(false);

      // The original mintPoPRewards should have succeeded
      expect(await MaliciousHemi.balanceOf(addresses[0])).to.be.gt(0);
    });

    // Tests nonReentrant on withdrawFunds with owner as the attacker contract.
    // The attacker is both an ERC20 and the owner, allowing direct reentrancy attempt.
    it("withdrawFunds direct reentrancy should revert with ReentrancyGuardReentrantCall", async function () {
      const { supplyOwner, owner, random1 } = await getAddresses();

      // Deploy the attacker contract (it's both an ERC20 token AND will be the owner)
      const AttackerFactory = await hre.ethers.getContractFactory("OwnerReentrantAttacker");
      const Attacker = await AttackerFactory.deploy();

      // Deploy a real Hemi token for the PoPPayoutsV2 contract
      const HemiFactory = await hre.ethers.getContractFactory("Hemi");
      const Hemi = await HemiFactory.deploy(owner.address, owner.address, YEARLY_TOKEN_INFLATION);

      const now = await time.latest();
      await time.increaseTo(now + 1);

      // Deploy PoPPayoutsV2 with empty constructor
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2WithAttacker = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract with the Attacker contract as the OWNER (all 8 parameters)
      await Attacker.initializeContract(
        PoPPayoutsV2WithAttacker,
        Attacker, // owner is attacker
        supplyOwner.address,
        Hemi,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      // Configure the attacker
      await Attacker.setTarget(PoPPayoutsV2WithAttacker);

      // Fund the PoPPayoutsV2 contract with the attacker's tokens
      await Attacker.fundTarget(hre.ethers.parseUnits("10000", 18));

      // Enable the attack
      await Attacker.enableAttack();

      // Call withdrawFunds through the attacker - this will trigger token transfer,
      // which will attempt to reenter withdrawFunds directly
      // The entire transaction should revert with ReentrancyGuardReentrantCall
      await expect(Attacker.executeWithdraw(
        hre.ethers.parseUnits("500", 18),
        random1.address
      )).to.be.revertedWithCustomError(
        PoPPayoutsV2WithAttacker,
        "ReentrancyGuardReentrantCall"
      );
    });

    // Tests nonReentrant on mintPoPRewards using hardhat_setCode to deploy at the depositor address.
    // This scenario is impossible in production but verifies the modifier works as defense-in-depth.
    it("mintPoPRewards nonReentrant modifier should block reentrancy from depositor address", async function () {
      const { supplyOwner, owner } = await getAddresses();
      const DEPOSITOR_ADDRESS = "0x8888888888888888888888888888888888888888";

      // Deploy the attacker contract first (to get its bytecode)
      const AttackerFactory = await hre.ethers.getContractFactory("DepositorReentrantAttacker");
      const attackerDeployed = await AttackerFactory.deploy();

      // Get the deployed bytecode
      const attackerBytecode = await hre.ethers.provider.getCode(await attackerDeployed.getAddress());

      // Deploy the callback malicious HEMI token
      const MaliciousHemiFactory = await hre.ethers.getContractFactory("CallbackMaliciousHemi");
      const initialSupply = hre.ethers.parseUnits("1000000000", 18);
      const MaliciousHemi = await MaliciousHemiFactory.deploy(
        owner.address,
        initialSupply
      );

      const now = await time.latest();
      await time.increaseTo(now + 1);

      // Deploy PoPPayoutsV2 with the callback malicious Hemi token
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
        owner.address,
        supplyOwner.address,
        MaliciousHemi,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      // Transfer tokens to the payout contract
      await MaliciousHemi.connect(owner).transfer(
        PoPPayoutsV2Contract,
        hre.ethers.parseUnits("100000", 18)
      );

      // Mine some blocks to get past the keystone
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);
      const keystoneHeight = 50;

      // Now deploy the attacker bytecode at the depositor address using hardhat_setCode
      await hre.network.provider.send("hardhat_setCode", [
        DEPOSITOR_ADDRESS,
        attackerBytecode
      ]);

      // Get a reference to the attacker at the depositor address
      const attacker = AttackerFactory.attach(DEPOSITOR_ADDRESS);

      // Configure the callback malicious token to call back to the depositor
      await MaliciousHemi.setCallbackTarget(DEPOSITOR_ADDRESS);

      // Configure the attacker with attack parameters
      await attacker.setAttackParams(
        await PoPPayoutsV2Contract.getAddress(),
        BigInt(keystoneHeight + 25) // Try to reenter with a different keystone
      );

      // The attack flow:
      // 1. Attacker (at depositor address) calls mintPoPRewards with itself as recipient
      // 2. PoPPayoutsV2 calls MaliciousHemi.transfer(depositorAddress, reward)
      // 3. MaliciousHemi calls attacker.onTokenReceived()
      // 4. Attacker attempts to call mintPoPRewards again
      // 5. This should be blocked by nonReentrant (NOT by onlyDepositor since we ARE the depositor)

      // The outer mintPoPRewards should succeed, but the reentrant attempt should fail
      const addresses = [DEPOSITOR_ADDRESS]; // Depositor is recipient to trigger callback
      const heights = [0];

      await expect(attacker.initiateAttack(
        keystoneHeight,
        addresses,
        heights.map(h => h)
      )).to.emit(attacker, "ReentrancyAttempted").withArgs(false, "Low-level revert (expected: ReentrancyGuardReentrantCall)");

      // Verify the attack was attempted but reentrancy did not succeed
      expect(await attacker.attackAttempted()).to.equal(true);
      expect(await attacker.reentrancySucceeded()).to.equal(false);

      // The original mintPoPRewards should have succeeded (depositor received tokens)
      expect(await MaliciousHemi.balanceOf(DEPOSITOR_ADDRESS)).to.be.gt(0);
    });

    // Tests nonReentrant on withdrawETH via malicious receiver's receive() callback.
    it("withdrawETH should block reentrancy attempts", async function () {
      const { PoPPayoutsV2Contract, owner } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy the reentrant receiver contract
      const ReentrantReceiverFactory = await hre.ethers.getContractFactory("ReentrantETHReceiver");
      const reentrantReceiver = await ReentrantReceiverFactory.deploy();

      // Configure it to attack the PoPPayoutsV2 contract
      await reentrantReceiver.setTarget(PoPPayoutsV2Contract);
      await reentrantReceiver.enableAttack();

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("2.0") });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Verify contract has ETH
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(hre.ethers.parseEther("2.0"));

      // The receiver attempts reentrancy in its receive() callback, blocked by nonReentrant.
      // Low-level .call doesn't propagate custom errors, so we get "ETH transfer failed".
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawETH(
        hre.ethers.parseEther("1.0"),
        reentrantReceiver
      )).to.be.revertedWith("ETH transfer failed");
    });

    // Tests nonReentrant on protocolForceWithdrawETH via malicious receiver's receive() callback.
    it("protocolForceWithdrawETH should block reentrancy attempts", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Deploy the reentrant receiver contract
      const ReentrantReceiverFactory = await hre.ethers.getContractFactory("ReentrantETHReceiver");
      const reentrantReceiver = await ReentrantReceiverFactory.deploy();

      // Configure it to attack the PoPPayoutsV2 contract
      await reentrantReceiver.setTarget(PoPPayoutsV2Contract);
      await reentrantReceiver.enableAttack();

      // Force-send ETH to PoPPayoutsV2 via selfdestruct
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("2.0") });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // The receiver attempts reentrancy in its receive() callback, blocked by nonReentrant.
      // Low-level .call doesn't propagate custom errors, so we get "ETH transfer failed".
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
        hre.ethers.parseEther("1.0"),
        reentrantReceiver
      )).to.be.revertedWith("ETH transfer failed");
    });
  });

  describe("calculateBlockTimestamp Validation", function () {
    it("should revert when calculating timestamp for future block", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const futureBlock = currentBlock + 100;

      await expect(
        PoPPayoutsV2Contract.calculateBlockTimestamp(futureBlock)
      ).to.be.revertedWith("cannot calculate height for future block");
    });

    it("should revert when calculating timestamp for block number equal to current + 1", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const currentBlock = await hre.ethers.provider.getBlockNumber();

      await expect(
        PoPPayoutsV2Contract.calculateBlockTimestamp(currentBlock + 1)
      ).to.be.revertedWith("cannot calculate height for future block");
    });

    it("should succeed for current block number", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      const currentBlock = await hre.ethers.provider.getBlockNumber();

      // Should not revert - current block is valid
      const timestamp = await PoPPayoutsV2Contract.calculateBlockTimestamp(currentBlock);
      expect(timestamp).to.be.gt(0);
    });

    it("should succeed for past block number", async function () {
      const { PoPPayoutsV2Contract } = await loadFixture(deployPoPPayoutsV2Contract);

      // Mine some blocks first
      await hre.network.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const pastBlock = currentBlock - 50;

      // Should not revert - past block is valid
      const timestamp = await PoPPayoutsV2Contract.calculateBlockTimestamp(pastBlock);
      expect(timestamp).to.be.gt(0);

      // Past block timestamp should be less than current block timestamp
      const currentTimestamp = await PoPPayoutsV2Contract.calculateBlockTimestamp(currentBlock);
      expect(timestamp).to.be.lt(currentTimestamp);
    });
  });

  /**
   * Comprehensive stateful tests that exercise all contract functionality together.
   */
  describe("Stateful Multi-Function Mixed Tests", function () {
    // Constants for fuzzing
    const FUZZ_ITERATIONS = 2000;
    const INITIAL_FUZZ_TOKENS = hre.ethers.parseUnits("10000000000", 18); // 10 billion tokens (full supply) for extended fuzzing
    const MAX_PUBLICATIONS_PER_ROUND = 15; // Keep reasonable for gas
    const INITIAL_ETH_FORCE_SEND = hre.ethers.parseEther("10");

    // Action types for the state machine
    enum Action {
      MINT_POP_REWARDS,
      MINT_POP_REWARDS_NO_PUBLICATIONS,
      SKIP_ROUNDS,
      UPDATE_OWNER_INIT,
      UPDATE_OWNER_FINALIZE,
      UPDATE_OWNER_CANCEL,
      UPDATE_SUPPLY_OWNER_INIT,
      UPDATE_SUPPLY_OWNER_FINALIZE,
      UPDATE_SUPPLY_OWNER_CANCEL,
      PROTOCOL_FORCE_OWNER_UPDATE,
      PROTOCOL_FORCE_SUPPLY_OWNER_UPDATE,
      UPDATE_SUPPLY_INFORMATION,
      WITHDRAW_FUNDS_OWNER,
      WITHDRAW_FUNDS_PROTOCOL,
      WITHDRAW_ETH_OWNER,
      WITHDRAW_ETH_PROTOCOL,
      ADVANCE_TIME,
    }

    // State tracker for the fuzzing test
    interface FuzzState {
      currentOwner: string;
      pendingOwner: string;
      currentSupplyOwner: string;
      pendingSupplyOwner: string;
      supplyBase: bigint;
      supplyInflationYearly: bigint;
      popInflationAllocation: bigint;
      supplyTimestamp: bigint;
      lastBlockRewarded: bigint;
      nextRoundIndex: bigint;
      totalPoPRewards: bigint;
      roundHistory: Array<{ rewardPool: bigint; totalPoPScore: bigint }>;
      hemiBalance: bigint;
      randomTokenBalance: bigint;
      ethBalance: bigint;
    }

    // Helper to pick random element from array
    function randomChoice<T>(arr: T[]): T {
      return arr[Math.floor(Math.random() * arr.length)];
    }

    // Helper to generate random bigint in range
    function randomBigInt(min: bigint, max: bigint): bigint {
      const range = max - min;
      const randomValue = BigInt(Math.floor(Math.random() * Number(range)));
      return min + randomValue;
    }

    // Get list of valid actions based on current state
    function getValidActions(state: FuzzState, hasHemiBalance: boolean, hasEthBalance: boolean, hasRandomTokenBalance: boolean): Action[] {
      const actions: Action[] = [];

      // Payout actions - heavily weighted (20x each for regular payouts)
      // MINT_POP_REWARDS is the most common real-world action
      for (let i = 0; i < 20; i++) {
        actions.push(Action.MINT_POP_REWARDS);
      }
      // No-publication rounds happen occasionally
      for (let i = 0; i < 2; i++) {
        actions.push(Action.MINT_POP_REWARDS_NO_PUBLICATIONS);
      }

      // Skip rounds are less common
      actions.push(Action.SKIP_ROUNDS);

      // Owner update actions (weight: 1 each)
      if (state.pendingOwner === ZERO_ADDRESS) {
        actions.push(Action.UPDATE_OWNER_INIT);
      } else {
        actions.push(Action.UPDATE_OWNER_FINALIZE);
        actions.push(Action.UPDATE_OWNER_CANCEL);
      }

      // Supply owner update actions (weight: 1 each)
      if (state.pendingSupplyOwner === ZERO_ADDRESS) {
        actions.push(Action.UPDATE_SUPPLY_OWNER_INIT);
      } else {
        actions.push(Action.UPDATE_SUPPLY_OWNER_FINALIZE);
        actions.push(Action.UPDATE_SUPPLY_OWNER_CANCEL);
      }

      // Protocol force updates (weight: 1 each)
      actions.push(Action.PROTOCOL_FORCE_OWNER_UPDATE);
      actions.push(Action.PROTOCOL_FORCE_SUPPLY_OWNER_UPDATE);

      // Supply information update (weight: 1)
      actions.push(Action.UPDATE_SUPPLY_INFORMATION);

      // Withdrawal actions based on balances (weight: 1 each)
      if (hasHemiBalance) {
        actions.push(Action.WITHDRAW_FUNDS_OWNER);
        actions.push(Action.WITHDRAW_FUNDS_PROTOCOL);
      }
      if (hasRandomTokenBalance) {
        actions.push(Action.WITHDRAW_FUNDS_OWNER);
        actions.push(Action.WITHDRAW_FUNDS_PROTOCOL);
      }
      if (hasEthBalance) {
        actions.push(Action.WITHDRAW_ETH_OWNER);
        actions.push(Action.WITHDRAW_ETH_PROTOCOL);
      }

      // Time advancement - reduced weight (only 1)
      actions.push(Action.ADVANCE_TIME);

      return actions;
    }

    // Calculate expected reward pool for the next round
    async function calculateExpectedRewardPool(
      state: FuzzState,
      rewardTimestamp: bigint,
      firstRoundRewards: bigint
    ): Promise<bigint> {
      if (state.nextRoundIndex === 0n) {
        return firstRoundRewards;
      }

      let numerator = 0n;
      let denominator = 0n;

      for (let lookback = 0; lookback < rewardLookbackWeighting.length; lookback++) {
        const roundIndex = Number(state.nextRoundIndex) - 1 - lookback;
        if (roundIndex < 0) break;

        const round = state.roundHistory[roundIndex];
        let retargetingMultiplier = 10n * BPS; // No score multiplier

        if (round.totalPoPScore > 0n) {
          retargetingMultiplier = (TARGET_SCORE * BPS) / round.totalPoPScore;
        }

        const adjustedRewardPool = (round.rewardPool * retargetingMultiplier) / BPS;
        numerator += adjustedRewardPool * BigInt(rewardLookbackWeighting[lookback]);
        denominator += BigInt(rewardLookbackWeighting[lookback]);
      }

      let result = numerator / denominator;

      // Calculate max reward pool
      const maxReward = await calculateMaximumRewardPool(
        Number(state.supplyTimestamp),
        state.supplyBase,
        Number(state.supplyInflationYearly),
        Number(state.popInflationAllocation),
        Number(rewardTimestamp)
      );

      if (result > maxReward) {
        result = maxReward;
      }

      return result;
    }


    it("should allow payout rounds during pending owner change", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Initiate owner change
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Advance blockchain and do a payout while owner change is pending
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted")
        .withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      // Owner change should still be pending
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // New owner should be able to finalize
      await PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize();
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
    });

    it("should allow payout rounds during pending supply owner change", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Initiate supply owner change (owner initiates, new supply owner finalizes)
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Advance blockchain and do a payout while supply owner change is pending
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted")
        .withArgs(25, INITIAL_REWARD, publicationHeightScores[0]);

      // Supply owner change should still be pending
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // New supply owner should be able to finalize
      await PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerFinalize();
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random1.address);
    });

    it("should use updated supply parameters for payouts after supply update", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyOwner, supplyTimestamp } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract with lots of tokens
      const largeAmount = hre.ethers.parseUnits("100000000", 18);
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, largeAmount);

      // Do first payout round
      await time.increase(50 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(50).toString(16)]);

      const tx1 = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        25,
        ["0x1111111111111111111111111111111111111111"],
        [0]
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const firstRewardPool = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event1!.topics], data: event1!.data })?.args[1];

      // Update supply to a higher base (simulating token distribution)
      // Keep original supplyTimestamp to avoid "time cannot be below supply timestamp" errors
      // (setting it to current time would cause issues when calculating block timestamps for past keystones)
      const newSupplyBase = INITIAL_SUPPLY * 2n;
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp
      );

      // Do second payout round - should have higher reward pool due to doubled supply
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(25).toString(16)]);

      const tx2 = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        50,
        ["0x2222222222222222222222222222222222222222"],
        [0]
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find(log => {
        try {
          return PoPPayoutsV2Contract.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "PayoutRoundExecuted";
        } catch { return false; }
      });
      const secondRewardPool = PoPPayoutsV2Contract.interface.parseLog({ topics: [...event2!.topics], data: event2!.data })?.args[1];

      // First round uses INITIAL_REWARD directly
      expect(firstRewardPool).to.equal(INITIAL_REWARD);

      // Second round calculates reward using weighted average:
      // - Round 1 had 100K score (1 optimal publication) vs 500K target = 5x multiplier
      // - So second reward pool = 5 * INITIAL_REWARD = 500 tokens
      // - This is capped by max reward pool, which doubled with supply
      const expectedSecondReward = INITIAL_REWARD * 5n;
      expect(secondRewardPool).to.equal(expectedSecondReward);

      // Verify the new max reward pool is approximately 2x the original
      // (proves the doubled supply is being used in calculations)
      const currentTimestamp = await time.latest();
      const newMaxReward = await PoPPayoutsV2Contract.calculateMaximumRewardPool(currentTimestamp);
      // Original max was ~4753 tokens, doubled should be ~9506
      expect(newMaxReward).to.be.gte(MAXIMUM_INITIAL_REWARD * 2n - MAXIMUM_INITIAL_REWARD / 100n); // Allow 1% tolerance
      expect(newMaxReward).to.be.lte(MAXIMUM_INITIAL_REWARD * 2n + MAXIMUM_INITIAL_REWARD / 100n);
    });

    it("should allow protocol force owner update to interrupt pending owner change", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Owner initiates change to random1
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol forces change to random2 instead
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random2.address);

      // random2 should now be owner, not random1
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);

      // random1 should not be able to finalize (pending owner was cleared by force update)
      await expect(PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize())
        .to.be.revertedWith("can not finalize owner update when no pending owner update is in progress");
    });

    it("should allow protocol force supply owner update to interrupt pending supply owner change", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Owner initiates supply owner change to random1
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Protocol forces change to random2 instead
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(random2.address);

      // random2 should now be supply owner, not random1
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      // random1 should not be able to finalize (pending supply owner was cleared by force update)
      await expect(PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerFinalize())
        .to.be.revertedWith("can not finalize supply owner update when no pending supply owner update is in progress");
    });

    it("should handle simultaneous owner and supply owner changes independently", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Initiate both owner and supply owner changes (both initiated by owner)
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random2.address);

      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);

      // Finalize supply owner change first
      await PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerFinalize();
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);

      // Owner change should still be pending
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.owner()).to.equal(owner.address);

      // Finalize owner change
      await PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize();
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
    });

    it("should allow old owner to withdraw funds after initiating but before finalizing transfer", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Initiate owner change
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);

      // Old owner should still be able to withdraw
      const withdrawAmount = hre.ethers.parseUnits("100", 18);
      await expect(PoPPayoutsV2Contract.connect(owner).withdrawFunds(
        HemiContract,
        withdrawAmount,
        owner.address
      )).to.emit(PoPPayoutsV2Contract, "WithdrawFundsSuccessful");

      expect(await HemiContract.balanceOf(owner.address)).to.equal(withdrawAmount);
    });

    it("should not allow new owner to withdraw funds before finalizing transfer", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, owner, random1 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_PAYOUT_TOKENS);

      // Initiate owner change
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);

      // New owner (pending) should NOT be able to withdraw yet
      const withdrawAmount = hre.ethers.parseUnits("100", 18);
      await expect(PoPPayoutsV2Contract.connect(random1).withdrawFunds(
        HemiContract,
        withdrawAmount,
        random1.address
      )).to.be.revertedWith("only the owner can call this function");
    });

    it("should handle long gaps in publications correctly", async function () {
      this.timeout(120000);

      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_FUZZ_TOKENS);

      // Get current block number and calculate next keystone
      let currentBlock = BigInt(await hre.network.provider.send("eth_blockNumber", []));
      const nextKeystone = (currentBlock / 25n + 1n) * 25n; // Round up to next keystone
      const blocksToAdvance = Number(nextKeystone - currentBlock);

      // Perform first payout - advance to first keystone
      await time.increase(blocksToAdvance * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + blocksToAdvance.toString(16)]);
      let keystoneBlock = nextKeystone;
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(keystoneBlock, [PROTOCOL_ADDRESS], [0]);

      // Build up 30 rounds of history with varying publication counts
      for (let i = 1; i <= 30; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        keystoneBlock += 25n;

        // Vary publications: some with 0, some with 1, some with multiple
        const pubCount = i % 5; // 0, 1, 2, 3, 4 publications
        const addresses = Array.from({ length: pubCount }, () => PROTOCOL_ADDRESS);
        const heights = Array.from({ length: pubCount }, (_, j) => j % 9);

        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystoneBlock, addresses, heights
        );
      }

      const nextRoundIndex = await PoPPayoutsV2Contract.getRoundsCount();
      expect(nextRoundIndex).to.equal(31); // First round + 30 more

      // Verify we can continue making payouts
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      keystoneBlock += 25n;

      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystoneBlock, [PROTOCOL_ADDRESS], [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");
    });

    it("should handle owner and supplyOwner transfers during active payouts", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyOwner, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_FUZZ_TOKENS);

      // Get current block number and calculate next keystone
      let currentBlock = BigInt(await hre.network.provider.send("eth_blockNumber", []));
      const nextKeystone = (currentBlock / 25n + 1n) * 25n;
      const blocksToAdvance = Number(nextKeystone - currentBlock);
      let keystoneBlock = nextKeystone;

      // Build up history first with sequential payouts
      await time.increase(blocksToAdvance * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + blocksToAdvance.toString(16)]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(keystoneBlock, [random1.address], [0]);

      for (let i = 1; i < 5; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        keystoneBlock += 25n;
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(keystoneBlock, [random1.address], [0]);
      }

      // Initiate owner transfer
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);

      // Do another payout while owner transfer is pending
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      keystoneBlock += 25n;
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(keystoneBlock, [random2.address], [0]);

      // Complete owner transfer
      await PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize();
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);

      // Initiate supply owner transfer
      await PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerInit(random2.address);

      // Do another payout while supply owner transfer is pending
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      keystoneBlock += 25n;
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(keystoneBlock, [random1.address], [0]);

      // Complete supply owner transfer
      await PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerFinalize();
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);

      // Verify new supply owner can update supply info (must use timestamp >= supplyTimestamp)
      const contractSupplyTimestamp = await PoPPayoutsV2Contract.supplyTimestamp();
      await PoPPayoutsV2Contract.connect(random2).updateSupplyInformation(
        INITIAL_SUPPLY + hre.ethers.parseUnits("1000000", 18),
        600, // Reduce inflation to 6% (600 BPS)
        400, // Reduce PoP allocation to 4% (400 BPS)
        Number(contractSupplyTimestamp) // Keep same supply timestamp
      );

      // Verify payout still works after all transfers
      await time.increase(25 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x19"]);
      keystoneBlock += 25n;
      await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystoneBlock, [random1.address], [0]
      )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");
    });

    it("should handle supply parameter changes correctly", async function () {
      this.timeout(120000);

      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, supplyOwner } = await loadFixture(deployPoPPayoutsV2Contract);

      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_FUZZ_TOKENS);

      // Get current block number and calculate next keystone
      let currentBlock = BigInt(await hre.network.provider.send("eth_blockNumber", []));
      const nextKeystone = (currentBlock / 25n + 1n) * 25n;
      const blocksToAdvance = Number(nextKeystone - currentBlock);
      let keystoneBlock = nextKeystone;

      // Do some initial payouts to build history - first one advances to keystone
      await time.increase(blocksToAdvance * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + blocksToAdvance.toString(16)]);
      await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
        keystoneBlock, [PROTOCOL_ADDRESS], [0]
      );

      for (let i = 1; i < 10; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        keystoneBlock += 25n;
        await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystoneBlock, [PROTOCOL_ADDRESS], [0]
        );
      }

      // Update supply information to reflect increased base
      const newSupplyBase = INITIAL_SUPPLY + hre.ethers.parseUnits("50000000", 18);
      const contractSupplyTimestamp = await PoPPayoutsV2Contract.supplyTimestamp();

      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        Number(contractSupplyTimestamp) // Keep same supply timestamp
      );

      // Verify supply base was updated
      expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(newSupplyBase);

      // Do more payouts with new supply parameters
      for (let i = 10; i < 20; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        keystoneBlock += 25n;

        const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystoneBlock, [PROTOCOL_ADDRESS], [0]
        );
        const receipt = await tx.wait();

        // Verify payout succeeded
        const payoutEvents = receipt!.logs.filter((log: any) => {
          try {
            const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
            return parsed?.name === "PayoutRoundExecuted";
          } catch { return false; }
        });
        expect(payoutEvents.length).to.be.gt(0);
      }

      // Update inflation and PoP allocation
      await PoPPayoutsV2Contract.connect(supplyOwner).updateSupplyInformation(
        newSupplyBase,
        600, // Reduce inflation to 6%
        400, // Reduce PoP allocation to 4%
        Number(contractSupplyTimestamp)
      );

      expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(600);
      expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(400);

      // Continue payouts with new parameters
      for (let i = 20; i < 25; i++) {
        await time.increase(25 * 12);
        await hre.network.provider.send("hardhat_mine", ["0x19"]);
        keystoneBlock += 25n;

        await expect(PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
          keystoneBlock, [PROTOCOL_ADDRESS], [0]
        )).to.emit(PoPPayoutsV2Contract, "PayoutRoundExecuted");
      }
    });

    it("should correctly handle interleaved ERC20 and ETH withdrawals", async function () {
      const { PoPPayoutsV2Contract, HemiContract, initialMintReceiver, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);
      const { RandomERC20Contract, initialRandomTokenReceiver } = await deployRandomToken();

      // Fund with multiple assets
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_FUZZ_TOKENS);
      await RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(PoPPayoutsV2Contract, hre.ethers.parseUnits("1000", 18));

      // Force send ETH
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: hre.ethers.parseEther("5") });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Track balances
      const initialHemiBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
      const initialRandomBalance = await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract);
      const initialEthBalance = await hre.ethers.provider.getBalance(PoPPayoutsV2Contract);

      // Interleave different types of withdrawals
      await PoPPayoutsV2Contract.connect(owner).withdrawFunds(HemiContract, hre.ethers.parseUnits("100", 18), random1.address);
      await PoPPayoutsV2Contract.connect(owner).withdrawETH(hre.ethers.parseEther("1"), random1.address);
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(RandomERC20Contract, hre.ethers.parseUnits("50", 18), random2.address);
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(hre.ethers.parseEther("0.5"), random2.address);
      await PoPPayoutsV2Contract.connect(owner).withdrawFunds(HemiContract, hre.ethers.parseUnits("200", 18), random2.address);

      // Verify balances changed correctly
      expect(await HemiContract.balanceOf(PoPPayoutsV2Contract)).to.equal(
        initialHemiBalance - hre.ethers.parseUnits("300", 18)
      );
      expect(await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract)).to.equal(
        initialRandomBalance - hre.ethers.parseUnits("50", 18)
      );
      expect(await hre.ethers.provider.getBalance(PoPPayoutsV2Contract)).to.equal(
        initialEthBalance - hre.ethers.parseEther("1.5")
      );

      // Verify recipients received funds
      expect(await HemiContract.balanceOf(random1.address)).to.equal(hre.ethers.parseUnits("100", 18));
      expect(await HemiContract.balanceOf(random2.address)).to.equal(hre.ethers.parseUnits("200", 18));
      expect(await RandomERC20Contract.balanceOf(random2.address)).to.equal(hre.ethers.parseUnits("50", 18));
    });

    it("should deploy successfully with firstRoundRewards at exact maximum allowed by inflation and calculate rewards correctly", async function () {
      const { HemiContract } = await loadFixture(deployHemiToken);
      const { supplyOwner, owner, initialMintReceiver } = await getAddresses();
      const now = await time.latest();

      // Deploy and initialize a test contract first to get the actual max reward from the contract
      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const testContract = await PoPPayoutsV2Factory.deploy();
      await testContract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now,
        INITIAL_REWARD
      );

      // Get the actual maximum from the initialized contract
      const exactMaxReward = await testContract.calculateMaximumRewardPool(now);

      // Deploy with exact maximum - should succeed
      const contract = await PoPPayoutsV2Factory.deploy();
      await contract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now + 1,
        exactMaxReward
      );

      expect(await contract.firstRoundRewards()).to.equal(exactMaxReward);

      // Verify that max + 1 would fail in initialize
      const failContract = await PoPPayoutsV2Factory.deploy();
      await expect(failContract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        now + 2,
        exactMaxReward + 1n
      )).to.be.revertedWith("first round rewards exceed maximum allowed by inflation");

      // ========== Now verify payout rounds work correctly with max firstRoundRewards ==========

      // Fund the contract generously (need enough for multiple max-reward rounds)
      const fundingAmount = exactMaxReward * 100n;
      await HemiContract.connect(initialMintReceiver).transfer(contract, fundingAmount);
      expect(await HemiContract.balanceOf(contract)).to.equal(fundingAmount);

      // Advance time and blocks to enable payouts
      await time.increase(100 * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(100).toString(16)]);

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      let keystone = Math.floor((currentBlock - 10) / KEYSTONE_FREQUENCY) * KEYSTONE_FREQUENCY;

      const depositor = await protocolSigner;

      // Test Round 1: Single optimal publication - should use firstRoundRewards (the max)
      const balanceBefore1 = await HemiContract.balanceOf(contract);
      const tx1 = await contract.connect(depositor).mintPoPRewards(
        keystone,
        [PROTOCOL_ADDRESS],
        [0]
      );
      const receipt1 = await tx1.wait();
      const balanceAfter1 = await HemiContract.balanceOf(contract);
      const paid1 = balanceBefore1 - balanceAfter1;

      // First round should use exactMaxReward as the reward pool
      const round0 = await contract.rounds(0);
      expect(round0.rewardPool).to.equal(exactMaxReward, "First round should use max firstRoundRewards");
      expect(paid1).to.be.lte(exactMaxReward, "First round payout should not exceed reward pool");
      expect(paid1).to.be.gt(0n, "First round should pay out tokens");

      // Test Round 2: Multiple publications at various heights
      keystone += KEYSTONE_FREQUENCY;
      await time.increase(KEYSTONE_FREQUENCY * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

      const balanceBefore2 = await HemiContract.balanceOf(contract);
      await contract.connect(depositor).mintPoPRewards(
        keystone,
        [PROTOCOL_ADDRESS, PROTOCOL_ADDRESS, PROTOCOL_ADDRESS, PROTOCOL_ADDRESS, PROTOCOL_ADDRESS],
        [0, 1, 2, 3, 4]
      );
      const balanceAfter2 = await HemiContract.balanceOf(contract);
      const paid2 = balanceBefore2 - balanceAfter2;

      const round1 = await contract.rounds(1);
      expect(round1.rewardPool).to.be.gt(0n, "Second round should have positive reward pool");
      expect(paid2).to.be.lte(round1.rewardPool, "Second round payout should not exceed reward pool");

      // Test Round 3: Maximum publications (75) with mixed heights
      keystone += KEYSTONE_FREQUENCY;
      await time.increase(KEYSTONE_FREQUENCY * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

      const addresses75 = Array(75).fill(PROTOCOL_ADDRESS);
      const heights75 = [0, ...Array(74).fill(0).map((_, i) => i % 9)]; // First element is 0, remaining 74 cycle through 0-8

      const balanceBefore3 = await HemiContract.balanceOf(contract);
      await contract.connect(depositor).mintPoPRewards(keystone, addresses75, heights75);
      const balanceAfter3 = await HemiContract.balanceOf(contract);
      const paid3 = balanceBefore3 - balanceAfter3;

      const round2 = await contract.rounds(2);
      expect(round2.rewardPool).to.be.gt(0n, "Third round should have positive reward pool");
      expect(paid3).to.be.lte(round2.rewardPool, "Third round payout should not exceed reward pool");

      // Test Round 4: Zero publications (skipped round)
      keystone += KEYSTONE_FREQUENCY;
      await time.increase(KEYSTONE_FREQUENCY * 12);
      await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

      const balanceBefore4 = await HemiContract.balanceOf(contract);
      await contract.connect(depositor).mintPoPRewards(keystone, [], []);
      const balanceAfter4 = await HemiContract.balanceOf(contract);
      const paid4 = balanceBefore4 - balanceAfter4;

      const round3 = await contract.rounds(3);
      expect(round3.rewardPool).to.be.gt(0n, "Skipped round should have positive reward pool");
      expect(round3.totalPoPScore).to.equal(0n, "Skipped round should have zero PoP score");
      expect(paid4).to.equal(0n, "Skipped round should not pay out any tokens");

      // Test Rounds 5-10: Continue with various patterns to verify weighted average calculation
      // works correctly when starting from max firstRoundRewards
      for (let i = 0; i < 6; i++) {
        keystone += KEYSTONE_FREQUENCY;
        await time.increase(KEYSTONE_FREQUENCY * 12);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(KEYSTONE_FREQUENCY).toString(16)]);

        const pubCount = (i % 5) + 1; // 1 to 5 publications
        const addresses = Array(pubCount).fill(PROTOCOL_ADDRESS);
        const heights = [0, ...Array(pubCount - 1).fill(0).map((_, j) => j % 9)];

        const balanceBefore = await HemiContract.balanceOf(contract);
        await contract.connect(depositor).mintPoPRewards(keystone, addresses, heights);
        const balanceAfter = await HemiContract.balanceOf(contract);
        const paid = balanceBefore - balanceAfter;

        const round = await contract.rounds(4 + i);
        expect(round.rewardPool).to.be.gt(0n, `Round ${4 + i} should have positive reward pool`);
        expect(paid).to.be.lte(round.rewardPool, `Round ${4 + i} payout should not exceed reward pool`);
      }

      // Verify total rounds count
      expect(await contract.getRoundsCount()).to.equal(10n, "Should have executed 10 rounds");

      // Verify totalPoPRewards accumulated correctly
      const totalRewards = await contract.totalPoPRewards();
      expect(totalRewards).to.be.gt(0n, "Total PoP rewards should be positive");

      // Verify contract still has remaining balance
      const finalBalance = await HemiContract.balanceOf(contract);
      expect(finalBalance).to.be.gt(0n, "Contract should have remaining balance");
      expect(finalBalance).to.be.lt(fundingAmount, "Contract balance should have decreased");
    });

     it("should handle both pendingOwner and pendingSupplyOwner being set simultaneously", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init both owner and supply owner updates
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random2.address);

      // Both should be pending
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);

      // Finalize owner update
      await PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize();

      // Owner changed, supply owner update still pending
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);

      // Finalize supply owner update
      await PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerFinalize();

      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(ZERO_ADDRESS);
    });

    it("should allow canceling one update while the other remains pending", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init both updates
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random2.address);

      // Cancel owner update
      await PoPPayoutsV2Contract.connect(owner).updateOwnerCancel();

      // Owner update canceled, supply owner update still pending
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(ZERO_ADDRESS);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random2.address);

      // Finalize supply owner update should still work
      await PoPPayoutsV2Contract.connect(random2).updateSupplyOwnerFinalize();
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
    });

    it("should handle protocol force owner update while supply owner update is pending", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init supply owner update
      await PoPPayoutsV2Contract.connect(owner).updateSupplyOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Protocol force owner update
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(random2.address);

      // Owner changed, supply owner update still pending
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(random1.address);

      // Supply owner update can still be finalized
      await PoPPayoutsV2Contract.connect(random1).updateSupplyOwnerFinalize();
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random1.address);
    });

    it("should handle protocol force supply owner update while owner update is pending", async function () {
      const { PoPPayoutsV2Contract, owner, random1, random2 } = await loadFixture(deployPoPPayoutsV2Contract);

      // Init owner update
      await PoPPayoutsV2Contract.connect(owner).updateOwnerInit(random1.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Protocol force supply owner update
      await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(random2.address);

      // Supply owner changed, owner update still pending
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(random2.address);
      expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(random1.address);

      // Owner update can still be finalized
      await PoPPayoutsV2Contract.connect(random1).updateOwnerFinalize();
      expect(await PoPPayoutsV2Contract.owner()).to.equal(random1.address);
    });

    itCoverageDisabled("chaos monkey: should handle random sequences of all operations correctly (this can take several minutes)", async function () {
      this.timeout(1200000); // 20 minutes

      // Deploy contracts
      const { HemiContract } = await deployHemiToken();
      const { RandomERC20Contract, initialRandomTokenReceiver } = await deployRandomToken();
      const { hemiTokenOwner, initialMintReceiver, supplyOwner, owner, random1, random2, random3, random4 } = await getAddresses();

      const candidateAddresses = [random1.address, random2.address, random3.address, random4.address];

      const supplyTimestamp = await time.latest();

      const PoPPayoutsV2Factory = await hre.ethers.getContractFactory("PoPPayoutsV2");
      const PoPPayoutsV2Contract = await PoPPayoutsV2Factory.deploy();

      // Initialize the contract after deployment with all parameters
      await PoPPayoutsV2Contract.initialize(
        owner.address,
        supplyOwner.address,
        HemiContract,
        INITIAL_SUPPLY,
        YEARLY_TOKEN_INFLATION,
        POP_INFLATION_ALLOCATION,
        supplyTimestamp,
        INITIAL_REWARD
      );

      // Fund the contract
      await HemiContract.connect(initialMintReceiver).transfer(PoPPayoutsV2Contract, INITIAL_FUZZ_TOKENS);
      await RandomERC20Contract.connect(initialRandomTokenReceiver).transfer(PoPPayoutsV2Contract, INITIAL_RANDOM_TOKEN_SUPPLY / 2n);

      // Fund the protocol signer with enough ETH for extended fuzzing
      await hre.network.provider.send("hardhat_setBalance", [
        PROTOCOL_ADDRESS,
        hre.ethers.toBeHex(hre.ethers.parseEther("1000").toString()),
      ]);

      // Force send ETH via selfdestruct
      const SelfDestructFactory = await hre.ethers.getContractFactory("SelfDestructSender");
      const selfDestructContract = await SelfDestructFactory.deploy({ value: INITIAL_ETH_FORCE_SEND });
      await selfDestructContract.destroy(PoPPayoutsV2Contract);

      // Initialize state tracker
      const state: FuzzState = {
        currentOwner: owner.address,
        pendingOwner: ZERO_ADDRESS,
        currentSupplyOwner: supplyOwner.address,
        pendingSupplyOwner: ZERO_ADDRESS,
        supplyBase: INITIAL_SUPPLY,
        supplyInflationYearly: BigInt(YEARLY_TOKEN_INFLATION),
        popInflationAllocation: BigInt(POP_INFLATION_ALLOCATION),
        supplyTimestamp: BigInt(supplyTimestamp),
        lastBlockRewarded: 0n,
        nextRoundIndex: 0n,
        totalPoPRewards: 0n,
        roundHistory: [],
        hemiBalance: INITIAL_FUZZ_TOKENS,
        randomTokenBalance: INITIAL_RANDOM_TOKEN_SUPPLY / 2n,
        ethBalance: INITIAL_ETH_FORCE_SEND,
      };

      // Track current block for keystone calculations
      let currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());

      // Perform initial payout to establish a valid lastBlockRewarded
      // This prevents timestamp issues when advancing time before any payouts
      const initialKeystone = ((currentBlockNumber / 25n) + 1n) * 25n;
      const initialBlocksToAdvance = Number(initialKeystone - currentBlockNumber);
      if (initialBlocksToAdvance > 0) {
        await time.increase(initialBlocksToAdvance * BLOCK_TIME_SEC);
        await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(initialBlocksToAdvance).toString(16)]);
      }
      const initialTx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(initialKeystone, [random1.address], [0]);
      const initialReceipt = await initialTx.wait();

      // Parse the PayoutRoundExecuted event to get the reward pool
      for (const log of initialReceipt!.logs) {
        try {
          const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "PayoutRoundExecuted") {
            state.roundHistory.push({
              rewardPool: parsed.args.rewardPool,
              totalPoPScore: parsed.args.popScore
            });
          }
        } catch { /* ignore */ }
      }

      state.lastBlockRewarded = initialKeystone;
      state.nextRoundIndex = 1n;
      state.totalPoPRewards = await PoPPayoutsV2Contract.totalPoPRewards();
      currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());

      // Helper to get signer for current owner
      async function getCurrentOwnerSigner() {
        if (state.currentOwner === owner.address) return owner;
        if (state.currentOwner === random1.address) return random1;
        if (state.currentOwner === random2.address) return random2;
        if (state.currentOwner === random3.address) return random3;
        if (state.currentOwner === random4.address) return random4;
        throw new Error(`Unknown owner: ${state.currentOwner}`);
      }

      // Helper to get signer for current supply owner
      async function getCurrentSupplyOwnerSigner() {
        if (state.currentSupplyOwner === supplyOwner.address) return supplyOwner;
        if (state.currentSupplyOwner === random1.address) return random1;
        if (state.currentSupplyOwner === random2.address) return random2;
        if (state.currentSupplyOwner === random3.address) return random3;
        if (state.currentSupplyOwner === random4.address) return random4;
        throw new Error(`Unknown supply owner: ${state.currentSupplyOwner}`);
      }

      // Helper to get signer for pending owner
      async function getPendingOwnerSigner() {
        if (state.pendingOwner === random1.address) return random1;
        if (state.pendingOwner === random2.address) return random2;
        if (state.pendingOwner === random3.address) return random3;
        if (state.pendingOwner === random4.address) return random4;
        throw new Error(`Unknown pending owner: ${state.pendingOwner}`);
      }

      // Helper to get signer for pending supply owner
      async function getPendingSupplyOwnerSigner() {
        if (state.pendingSupplyOwner === random1.address) return random1;
        if (state.pendingSupplyOwner === random2.address) return random2;
        if (state.pendingSupplyOwner === random3.address) return random3;
        if (state.pendingSupplyOwner === random4.address) return random4;
        throw new Error(`Unknown pending supply owner: ${state.pendingSupplyOwner}`);
      }

      // Track statistics
      const actionCounts: Record<string, number> = {};
      const actionSuccesses: Record<string, number> = {};
      const actionFailures: Record<string, number> = {};
      let successfulPayouts = 0;
      let totalPublications = 0;
      let totalActionsAttempted = 0;
      let totalActionsCaught = 0;
      let payoutFailureReasons: Record<string, number> = {};

      // Track simulation metrics
      const firstKeystone = initialKeystone;
      const startTimestamp = await time.latest();
      let totalTokensDistributed = 0n;
      let firstInsufficientBalanceLogged = false;

      console.log(`    -> Starting chaos monkey with ${FUZZ_ITERATIONS} iterations...`);

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        // Refresh balances
        const contractHemiBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
        const contractRandomTokenBalance = await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract);
        const contractEthBalance = await hre.ethers.provider.getBalance(PoPPayoutsV2Contract);

        // Get valid actions
        const validActions = getValidActions(
          state,
          contractHemiBalance > 0n,
          contractEthBalance > 0n,
          contractRandomTokenBalance > 0n
        );

        // Pick random action
        const action = randomChoice(validActions);
        actionCounts[Action[action]] = (actionCounts[Action[action]] || 0) + 1;
        totalActionsAttempted++;
        let actionSucceeded = false;

        try {
          switch (action) {
            case Action.MINT_POP_REWARDS: {
              // Refresh current block from chain to avoid drift
              currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());

              // Sync lastBlockRewarded from contract to handle any state divergence
              const contractLastBlockRewarded = await PoPPayoutsV2Contract.lastBlockRewarded();
              state.lastBlockRewarded = contractLastBlockRewarded;

              // Calculate next keystone - ALWAYS use the next keystone after current block
              // This avoids timestamp issues from trying to backfill too many old blocks
              const nextKeystoneFromLast = state.lastBlockRewarded === 0n
                ? ((currentBlockNumber / 25n) + 1n) * 25n  // First keystone after current block
                : state.lastBlockRewarded + BigInt(KEYSTONE_FREQUENCY);
              const nextKeystoneFromCurrent = ((currentBlockNumber / 25n) + 1n) * 25n;
              const nextKeystone = nextKeystoneFromLast > nextKeystoneFromCurrent
                ? nextKeystoneFromLast
                : nextKeystoneFromCurrent;

              const blocksToAdvance = Number(nextKeystone - currentBlockNumber);
              if (blocksToAdvance > 0) {
                await time.increase(blocksToAdvance * BLOCK_TIME_SEC);
                await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToAdvance).toString(16)]);
                currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());
              }

              // Generate random publications (1-15)
              const numPubs = Math.floor(Math.random() * MAX_PUBLICATIONS_PER_ROUND) + 1;
              const addresses: string[] = [];
              const heights: number[] = [];

              for (let j = 0; j < numPubs; j++) {
                addresses.push(randomChoice(candidateAddresses));
                heights.push(Math.floor(Math.random() * 9));
              }
              // Ensure at least one height 0
              heights[Math.floor(Math.random() * numPubs)] = 0;

              // Calculate expected score per address and total
              const addressScores = new Map<string, bigint>();
              let expectedTotalScore = 0n;
              for (let j = 0; j < addresses.length; j++) {
                const h = heights[j];
                if (h < 9) {
                  const score = BigInt(publicationHeightScores[h]);
                  expectedTotalScore += score;
                  addressScores.set(addresses[j], (addressScores.get(addresses[j]) || 0n) + score);
                }
              }

              // Get balances before payout
              const balancesBefore = new Map<string, bigint>();
              for (const addr of addressScores.keys()) {
                balancesBefore.set(addr, await HemiContract.balanceOf(addr));
              }
              const totalPoPRewardsBefore = await PoPPayoutsV2Contract.totalPoPRewards();

              // Execute payout
              const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
                nextKeystone, addresses, heights
              );
              const receipt = await tx.wait();

              // Process ALL PayoutRoundExecuted events (including backfilled rounds)
              let targetEventRewardPool = 0n;
              let targetEventPopScore = 0n;
              let foundTargetEvent = false;

              for (const log of receipt!.logs) {
                try {
                  const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                  if (parsed?.name === "PayoutRoundExecuted") {
                    const eventBlock = parsed.args.blockRewarded;
                    state.roundHistory.push({
                      rewardPool: parsed.args.rewardPool,
                      totalPoPScore: parsed.args.popScore
                    });
                    state.nextRoundIndex++;

                    // Track the target keystone specifically for validation
                    if (eventBlock === nextKeystone) {
                      targetEventRewardPool = parsed.args.rewardPool;
                      targetEventPopScore = parsed.args.popScore;
                      foundTargetEvent = true;
                    }
                  }
                } catch { /* ignore */ }
              }

              if (foundTargetEvent) {
                // VALIDATION 1: Verify popScore matches our calculation for the target keystone
                expect(targetEventPopScore).to.equal(expectedTotalScore,
                  `popScore mismatch: expected ${expectedTotalScore}, got ${targetEventPopScore}`);

                // VALIDATION 2: Verify token transfers match expected pro-rata payouts
                // Note: Contract calculates per-publication, we calculate per-address, so there
                // can be rounding differences of up to 1 wei per publication for an address
                let expectedTotalPayout = 0n;
                const addressPubCounts = new Map<string, number>();
                for (let j = 0; j < addresses.length; j++) {
                  if (heights[j] < 9) {
                    addressPubCounts.set(addresses[j], (addressPubCounts.get(addresses[j]) || 0) + 1);
                  }
                }

                for (const [addr, score] of addressScores) {
                  const expectedPayout = (targetEventRewardPool * score) / expectedTotalScore;
                  const pubCount = addressPubCounts.get(addr) || 1;
                  const balanceAfter = await HemiContract.balanceOf(addr);
                  const actualPayout = balanceAfter - balancesBefore.get(addr)!;
                  // Allow for rounding differences of up to pubCount wei (1 per publication)
                  const difference = actualPayout > expectedPayout
                    ? actualPayout - expectedPayout
                    : expectedPayout - actualPayout;
                  expect(difference).to.be.lte(BigInt(pubCount),
                    `Payout mismatch for ${addr}: expected ~${expectedPayout}, got ${actualPayout}, diff ${difference}`);
                  expectedTotalPayout += actualPayout;
                }

                // VALIDATION 3: Verify totalPoPRewards state variable increased correctly
                const totalPoPRewardsAfter = await PoPPayoutsV2Contract.totalPoPRewards();
                expect(totalPoPRewardsAfter - totalPoPRewardsBefore).to.equal(expectedTotalPayout,
                  `totalPoPRewards increase mismatch`);
                state.totalPoPRewards = totalPoPRewardsAfter;

                state.lastBlockRewarded = nextKeystone;
                successfulPayouts++;
                totalPublications += numPubs;
                actionSucceeded = true;
              } else {
                payoutFailureReasons["MINT_POP_REWARDS: target event not found"] =
                  (payoutFailureReasons["MINT_POP_REWARDS: target event not found"] || 0) + 1;
              }
              break;
            }

            case Action.MINT_POP_REWARDS_NO_PUBLICATIONS: {
              // Refresh current block from chain to avoid drift
              currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());

              // Sync lastBlockRewarded from contract to handle any state divergence
              const contractLastBlockRewarded = await PoPPayoutsV2Contract.lastBlockRewarded();
              state.lastBlockRewarded = contractLastBlockRewarded;

              // Calculate next keystone - use whichever is greater:
              // - Next keystone after lastBlockRewarded
              // - Next keystone after current block (in case ADVANCE_TIME moved us forward)
              const nextKeystoneFromLast = state.lastBlockRewarded === 0n
                ? ((currentBlockNumber / 25n) + 1n) * 25n  // First keystone after current block
                : state.lastBlockRewarded + BigInt(KEYSTONE_FREQUENCY);
              const nextKeystoneFromCurrent = ((currentBlockNumber / 25n) + 1n) * 25n;
              const nextKeystone = nextKeystoneFromLast > nextKeystoneFromCurrent
                ? nextKeystoneFromLast
                : nextKeystoneFromCurrent;

              const blocksToAdvance = Number(nextKeystone - currentBlockNumber);
              if (blocksToAdvance > 0) {
                await time.increase(blocksToAdvance * BLOCK_TIME_SEC);
                await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToAdvance).toString(16)]);
                currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());
              }

              // Track totalPoPRewards before - should not change with no publications
              const totalPoPRewardsBefore = await PoPPayoutsV2Contract.totalPoPRewards();

              // Execute payout with no publications
              const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
                nextKeystone, [], []
              );
              const receipt = await tx.wait();

              // Process ALL PayoutRoundExecuted events (including backfilled rounds)
              let targetEventPopScore: bigint | null = null;
              let foundTargetEvent = false;

              for (const log of receipt!.logs) {
                try {
                  const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                  if (parsed?.name === "PayoutRoundExecuted") {
                    const eventBlock = parsed.args.blockRewarded;
                    state.roundHistory.push({
                      rewardPool: parsed.args.rewardPool,
                      totalPoPScore: parsed.args.popScore
                    });
                    state.nextRoundIndex++;

                    // Track the target keystone specifically for validation
                    if (eventBlock === nextKeystone) {
                      targetEventPopScore = parsed.args.popScore;
                      foundTargetEvent = true;
                    }
                  }
                } catch { /* ignore */ }
              }

              if (foundTargetEvent) {
                // VALIDATION 1: popScore should be 0 for no publications
                expect(targetEventPopScore).to.equal(0n,
                  `popScore should be 0 for no publications, got ${targetEventPopScore}`);

                // VALIDATION 2: totalPoPRewards should not change (no tokens distributed)
                const totalPoPRewardsAfter = await PoPPayoutsV2Contract.totalPoPRewards();
                expect(totalPoPRewardsAfter).to.equal(totalPoPRewardsBefore,
                  `totalPoPRewards should not change with no publications`);

                state.lastBlockRewarded = nextKeystone;
                successfulPayouts++;
                actionSucceeded = true;
              } else {
                payoutFailureReasons["MINT_POP_REWARDS_NO_PUBLICATIONS: target event not found"] =
                  (payoutFailureReasons["MINT_POP_REWARDS_NO_PUBLICATIONS: target event not found"] || 0) + 1;
              }
              break;
            }

            case Action.SKIP_ROUNDS: {
              // Refresh current block from chain to avoid drift
              currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());

              // Sync lastBlockRewarded from contract to handle any state divergence
              const contractLastBlockRewarded = await PoPPayoutsV2Contract.lastBlockRewarded();
              state.lastBlockRewarded = contractLastBlockRewarded;

              // Skip 1-30 keystones beyond the next expected keystone
              const numSkipped = Math.floor(Math.random() * 30) + 1;

              // Calculate base keystone - use whichever is greater:
              // - Next keystone after lastBlockRewarded
              // - Next keystone after current block (in case ADVANCE_TIME moved us forward)
              const nextKeystoneFromLast = state.lastBlockRewarded === 0n
                ? ((currentBlockNumber / 25n) + 1n) * 25n  // First keystone after current block
                : state.lastBlockRewarded + BigInt(KEYSTONE_FREQUENCY);
              const nextKeystoneFromCurrent = ((currentBlockNumber / 25n) + 1n) * 25n;
              const baseKeystone = nextKeystoneFromLast > nextKeystoneFromCurrent
                ? nextKeystoneFromLast
                : nextKeystoneFromCurrent;

              // Skip additional keystones beyond the base
              const targetKeystone = baseKeystone + BigInt(numSkipped * KEYSTONE_FREQUENCY);
              const blocksToAdvance = Number(targetKeystone - currentBlockNumber);

              if (blocksToAdvance > 0) {
                await time.increase(blocksToAdvance * BLOCK_TIME_SEC);
                await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToAdvance).toString(16)]);
                currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());
              }

              // Track balances before
              const balanceBefore = await HemiContract.balanceOf(random1.address);
              const totalPoPRewardsBefore = await PoPPayoutsV2Contract.totalPoPRewards();

              // Execute payout with 1 publication at height 0 (score = 100000)
              const expectedScore = BigInt(publicationHeightScores[0]);
              const tx = await PoPPayoutsV2Contract.connect(await protocolSigner).mintPoPRewards(
                targetKeystone, [random1.address], [0]
              );
              const receipt = await tx.wait();

              // Count and validate backfilled rounds from events
              let eventCount = 0;
              let lastEventRewardPool = 0n;
              let lastEventPopScore = 0n;
              for (const log of receipt!.logs) {
                try {
                  const parsed = PoPPayoutsV2Contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                  if (parsed?.name === "PayoutRoundExecuted") {
                    state.roundHistory.push({
                      rewardPool: parsed.args.rewardPool,
                      totalPoPScore: parsed.args.popScore
                    });
                    state.nextRoundIndex++;
                    eventCount++;
                    lastEventRewardPool = parsed.args.rewardPool;
                    lastEventPopScore = parsed.args.popScore;
                  }
                } catch { /* ignore */ }
              }

              // VALIDATION 1: The last event should have the correct popScore for our publication
              expect(lastEventPopScore).to.equal(expectedScore,
                `Last round popScore mismatch: expected ${expectedScore}, got ${lastEventPopScore}`);

              // VALIDATION 2: Verify token transfer to random1
              const balanceAfter = await HemiContract.balanceOf(random1.address);
              const expectedPayout = lastEventRewardPool; // 100% of reward pool goes to single publisher
              expect(balanceAfter - balanceBefore).to.equal(expectedPayout,
                `Payout mismatch for skipped rounds: expected ${expectedPayout}, got ${balanceAfter - balanceBefore}`);

              // VALIDATION 3: Verify totalPoPRewards increased correctly
              const totalPoPRewardsAfter = await PoPPayoutsV2Contract.totalPoPRewards();
              expect(totalPoPRewardsAfter - totalPoPRewardsBefore).to.equal(expectedPayout,
                `totalPoPRewards increase mismatch for skipped rounds`);
              state.totalPoPRewards = totalPoPRewardsAfter;

              state.lastBlockRewarded = targetKeystone;
              successfulPayouts++;
              actionSucceeded = true;
              break;
            }

            case Action.UPDATE_OWNER_INIT: {
              // Pick a new owner that's not the current one
              const candidates = candidateAddresses.filter(a => a !== state.currentOwner);
              if (candidates.length === 0) break;
              const newOwner = randomChoice(candidates);

              const ownerSigner = await getCurrentOwnerSigner();
              await PoPPayoutsV2Contract.connect(ownerSigner).updateOwnerInit(newOwner);
              state.pendingOwner = newOwner;
              break;
            }

            case Action.UPDATE_OWNER_FINALIZE: {
              if (state.pendingOwner === ZERO_ADDRESS) break;
              const pendingSigner = await getPendingOwnerSigner();
              await PoPPayoutsV2Contract.connect(pendingSigner).updateOwnerFinalize();
              state.currentOwner = state.pendingOwner;
              state.pendingOwner = ZERO_ADDRESS;
              break;
            }

            case Action.UPDATE_OWNER_CANCEL: {
              if (state.pendingOwner === ZERO_ADDRESS) break;
              // Either current owner or pending owner can cancel
              const signer = Math.random() > 0.5
                ? await getCurrentOwnerSigner()
                : await getPendingOwnerSigner();
              await PoPPayoutsV2Contract.connect(signer).updateOwnerCancel();
              state.pendingOwner = ZERO_ADDRESS;
              break;
            }

            case Action.UPDATE_SUPPLY_OWNER_INIT: {
              // Pick a new supply owner that's not the current one
              const candidates = candidateAddresses.filter(a => a !== state.currentSupplyOwner);
              if (candidates.length === 0) break;
              const newSupplyOwner = randomChoice(candidates);

              const ownerSigner = await getCurrentOwnerSigner();
              await PoPPayoutsV2Contract.connect(ownerSigner).updateSupplyOwnerInit(newSupplyOwner);
              state.pendingSupplyOwner = newSupplyOwner;
              break;
            }

            case Action.UPDATE_SUPPLY_OWNER_FINALIZE: {
              if (state.pendingSupplyOwner === ZERO_ADDRESS) break;
              const pendingSigner = await getPendingSupplyOwnerSigner();
              await PoPPayoutsV2Contract.connect(pendingSigner).updateSupplyOwnerFinalize();
              state.currentSupplyOwner = state.pendingSupplyOwner;
              state.pendingSupplyOwner = ZERO_ADDRESS;
              break;
            }

            case Action.UPDATE_SUPPLY_OWNER_CANCEL: {
              if (state.pendingSupplyOwner === ZERO_ADDRESS) break;
              // Either owner or pending supply owner can cancel
              const signer = Math.random() > 0.5
                ? await getCurrentOwnerSigner()
                : await getPendingSupplyOwnerSigner();
              await PoPPayoutsV2Contract.connect(signer).updateSupplyOwnerCancel();
              state.pendingSupplyOwner = ZERO_ADDRESS;
              break;
            }

            case Action.PROTOCOL_FORCE_OWNER_UPDATE: {
              const candidates = candidateAddresses.filter(a => a !== state.currentOwner);
              if (candidates.length === 0) break;
              const newOwner = randomChoice(candidates);

              await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceOwnerUpdate(newOwner);
              state.currentOwner = newOwner;
              state.pendingOwner = ZERO_ADDRESS;
              break;
            }

            case Action.PROTOCOL_FORCE_SUPPLY_OWNER_UPDATE: {
              const candidates = candidateAddresses.filter(a => a !== state.currentSupplyOwner);
              if (candidates.length === 0) break;
              const newSupplyOwner = randomChoice(candidates);

              await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceSupplyOwnerUpdate(newSupplyOwner);
              state.currentSupplyOwner = newSupplyOwner;
              state.pendingSupplyOwner = ZERO_ADDRESS;
              break;
            }

            case Action.UPDATE_SUPPLY_INFORMATION: {
              const currentTimestamp = await time.latest();

              // Randomly adjust supply parameters (within valid ranges)
              // Supply base can only increase
              const newSupplyBase = state.supplyBase + randomBigInt(0n, hre.ethers.parseUnits("1000000", 18));

              // Inflation can vary between 0-700 BPS
              // While the actual Hemi contract does not allow it to ever increase, PoPPayoutsV2
              // does as there may be reasons to set the inflation rate (temprorarily) lower than
              // the actual inflation in the Hemi token contract itself, and later restore it to
              // the correct value.
              const newInflation = randomBigInt(0n, 700n);

              // PoP allocation can vary between 0-min(500, newInflation) BPS
              const maxPoPAllocation = newInflation < 500n ? newInflation : 500n;
              const newPoPAllocation = randomBigInt(0n, maxPoPAllocation);

              // Timestamp can only increase, but we must be careful not to set it too high.
              // If we set it close to current time, backfilling old keystones will fail because
              // calculateBlockTimestamp(oldKeystone) could be before the new supplyTimestamp.
              // Solution: Only allow small increments (up to 1 hour) from the current supplyTimestamp.
              const maxTimestampIncrease = 3600; // 1 hour max increase
              const newTimestamp = Number(state.supplyTimestamp) + Math.floor(Math.random() * maxTimestampIncrease);

              // Ensure we don't exceed current time
              const safeTimestamp = Math.min(newTimestamp, currentTimestamp);

              const supplyOwnerSigner = await getCurrentSupplyOwnerSigner();
              await PoPPayoutsV2Contract.connect(supplyOwnerSigner).updateSupplyInformation(
                newSupplyBase,
                newInflation,
                newPoPAllocation,
                safeTimestamp
              );

              state.supplyBase = newSupplyBase;
              state.supplyInflationYearly = newInflation;
              state.popInflationAllocation = newPoPAllocation;
              state.supplyTimestamp = BigInt(safeTimestamp);
              break;
            }

            case Action.WITHDRAW_FUNDS_OWNER: {
              // Decide which token to withdraw
              const hemiBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
              const randomTokenBalance = await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract);

              if (hemiBalance > 0n && (randomTokenBalance === 0n || Math.random() > 0.5)) {
                // Limit HEMI withdrawals to max 0.1% of balance to preserve payout funds
                const maxHemiWithdraw = hemiBalance / 1000n;
                if (maxHemiWithdraw > 0n) {
                  const amount = randomBigInt(1n, maxHemiWithdraw);
                  const ownerSigner = await getCurrentOwnerSigner();
                  await PoPPayoutsV2Contract.connect(ownerSigner).withdrawFunds(
                    HemiContract, amount, randomChoice(candidateAddresses)
                  );
                }
              } else if (randomTokenBalance > 0n) {
                const amount = randomBigInt(1n, randomTokenBalance);
                const ownerSigner = await getCurrentOwnerSigner();
                await PoPPayoutsV2Contract.connect(ownerSigner).withdrawFunds(
                  RandomERC20Contract, amount, randomChoice(candidateAddresses)
                );
              }
              break;
            }

            case Action.WITHDRAW_FUNDS_PROTOCOL: {
              const hemiBalance = await HemiContract.balanceOf(PoPPayoutsV2Contract);
              const randomTokenBalance = await RandomERC20Contract.balanceOf(PoPPayoutsV2Contract);

              if (hemiBalance > 0n && (randomTokenBalance === 0n || Math.random() > 0.5)) {
                // Limit HEMI withdrawals to max 0.1% of balance to preserve payout funds
                const maxHemiWithdraw = hemiBalance / 1000n;
                if (maxHemiWithdraw > 0n) {
                  const amount = randomBigInt(1n, maxHemiWithdraw);
                  await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
                    HemiContract, amount, randomChoice(candidateAddresses)
                  );
                }
              } else if (randomTokenBalance > 0n) {
                const amount = randomBigInt(1n, randomTokenBalance);
                await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawFunds(
                  RandomERC20Contract, amount, randomChoice(candidateAddresses)
                );
              }
              break;
            }

            case Action.WITHDRAW_ETH_OWNER: {
              const ethBalance = await hre.ethers.provider.getBalance(PoPPayoutsV2Contract);
              if (ethBalance > 0n) {
                const amount = randomBigInt(1n, ethBalance);
                const ownerSigner = await getCurrentOwnerSigner();
                await PoPPayoutsV2Contract.connect(ownerSigner).withdrawETH(
                  amount, randomChoice(candidateAddresses)
                );
              }
              break;
            }

            case Action.WITHDRAW_ETH_PROTOCOL: {
              const ethBalance = await hre.ethers.provider.getBalance(PoPPayoutsV2Contract);
              if (ethBalance > 0n) {
                const amount = randomBigInt(1n, ethBalance);
                await PoPPayoutsV2Contract.connect(await protocolSigner).protocolForceWithdrawETH(
                  amount, randomChoice(candidateAddresses)
                );
              }
              break;
            }

            case Action.ADVANCE_TIME: {
              // Advance time by 1-30 days (could cross mintage periods)
              const daysToAdvance = Math.floor(Math.random() * 30) + 1;
              const secondsToAdvance = daysToAdvance * 86400;
              const blocksToAdvance = secondsToAdvance / BLOCK_TIME_SEC;

              await time.increase(secondsToAdvance);
              await hre.network.provider.send("hardhat_mine", ["0x" + BigInt(blocksToAdvance).toString(16)]);
              currentBlockNumber = BigInt(await hre.ethers.provider.getBlockNumber());
              break;
            }
          }
        } catch (error: any) {
          totalActionsCaught++;
          actionFailures[Action[action]] = (actionFailures[Action[action]] || 0) + 1;

          // Re-throw assertion errors - these are validation failures that should fail the test
          if (error.name === 'AssertionError' || error.message.includes('AssertionError') ||
              error.message.includes('expected') || error.message.includes('mismatch')) {
            throw error;
          }

          // Track payout-related failures
          if (action === Action.MINT_POP_REWARDS || action === Action.MINT_POP_REWARDS_NO_PUBLICATIONS || action === Action.SKIP_ROUNDS) {
            const reason = error.message.substring(0, 160);
            payoutFailureReasons[`${Action[action]}: ${reason}`] =
              (payoutFailureReasons[`${Action[action]}: ${reason}`] || 0) + 1;
          }
        }

        // Track successful actions
        if (actionSucceeded) {
          actionSuccesses[Action[action]] = (actionSuccesses[Action[action]] || 0) + 1;
        }

        // Validate state consistency every 10 iterations
        if (i % 10 === 0) {
          // Verify contract state matches our tracked state
          expect(await PoPPayoutsV2Contract.owner()).to.equal(state.currentOwner);
          expect(await PoPPayoutsV2Contract.pendingOwner()).to.equal(state.pendingOwner);
          expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(state.currentSupplyOwner);
          expect(await PoPPayoutsV2Contract.pendingSupplyOwner()).to.equal(state.pendingSupplyOwner);
          expect(await PoPPayoutsV2Contract.supplyBase()).to.equal(state.supplyBase);
          expect(await PoPPayoutsV2Contract.supplyInflationYearly()).to.equal(state.supplyInflationYearly);
          expect(await PoPPayoutsV2Contract.popInflationAllocation()).to.equal(state.popInflationAllocation);
          expect(await PoPPayoutsV2Contract.supplyTimestamp()).to.equal(state.supplyTimestamp);
          expect(await PoPPayoutsV2Contract.lastBlockRewarded()).to.equal(state.lastBlockRewarded);
          expect(await PoPPayoutsV2Contract.totalPoPRewards()).to.equal(state.totalPoPRewards);
          expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(state.nextRoundIndex);
        }
      }

      // Print statistics
      console.log(`    Chaos monkey complete!`);
      console.log(`    - Total actions attempted: ${totalActionsAttempted}`);
      console.log(`    - Actions caught in try/catch: ${totalActionsCaught}`);
      console.log(`    - Successful payouts: ${successfulPayouts}`);
      console.log(`    - Total publications processed: ${totalPublications}`);
      console.log(`    - Rounds in history: ${state.roundHistory.length}`);
      console.log(`    - Action distribution:`);
      for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
        const successes = actionSuccesses[action] || 0;
        const failures = actionFailures[action] || 0;
        console.log(`      - ${action}: ${count} (success: ${successes}, caught: ${failures})`);
      }

      // Print payout failure reasons if any
      if (Object.keys(payoutFailureReasons).length > 0) {
        console.log(`    - Payout failure reasons:`);
        for (const [reason, count] of Object.entries(payoutFailureReasons).sort((a, b) => b[1] - a[1])) {
          console.log(`      - ${reason}: ${count}`);
        }
      }

      // Get final state for summary
      const endTimestamp = await time.latest();
      const lastKeystone = state.lastBlockRewarded;
      const finalTotalPoPRewards = await PoPPayoutsV2Contract.totalPoPRewards();

      // Calculate time metrics
      const totalSimulatedSeconds = endTimestamp - startTimestamp;
      const totalSimulatedDays = Number(totalSimulatedSeconds) / 86400;
      const totalSimulatedYears = totalSimulatedDays / 365;
      const keystonesRewarded = Number(lastKeystone - firstKeystone) / KEYSTONE_FREQUENCY;

      // Print simulation summary
      console.log(`\n    ═══════════════════════════════════════════════════════════`);
      console.log(`    SIMULATION SUMMARY`);
      console.log(`    ═══════════════════════════════════════════════════════════`);
      console.log(`    Blockchain State:`);
      console.log(`      - First keystone rewarded: ${firstKeystone}`);
      console.log(`      - Last keystone rewarded:  ${lastKeystone}`);
      console.log(`      - Keystones covered:       ${keystonesRewarded}`);
      console.log(`      - Rounds in history:       ${state.roundHistory.length}`);
      console.log(`    Time Simulation:`);
      console.log(`      - Simulated time:          ${totalSimulatedDays.toFixed(1)} days (${totalSimulatedYears.toFixed(2)} years)`);
      console.log(`      - Avg time per keystone:   ${(totalSimulatedDays / keystonesRewarded * 24 * 60).toFixed(1)} minutes`);
      console.log(`    Payout Metrics:`);
      console.log(`      - Successful payouts:      ${successfulPayouts}`);
      console.log(`      - Total publications:      ${totalPublications}`);
      console.log(`      - Avg pubs per payout:     ${successfulPayouts > 0 ? (totalPublications / successfulPayouts).toFixed(1) : 0}`);
      console.log(`      - Total rewards distributed: ${hre.ethers.formatUnits(finalTotalPoPRewards, 18)} HEMI`);
      console.log(`    Success/Failure Metrics:`);
      console.log(`      - Actions attempted:       ${totalActionsAttempted}`);
      console.log(`      - Actions caught:          ${totalActionsCaught} (${(totalActionsCaught / totalActionsAttempted * 100).toFixed(1)}%)`);
      console.log(`      - Payout success rate:     ${((actionSuccesses['MINT_POP_REWARDS'] || 0) / (actionCounts['MINT_POP_REWARDS'] || 1) * 100).toFixed(1)}%`);
      console.log(`    ═══════════════════════════════════════════════════════════\n`);

      // Verify all iterations completed
      expect(totalActionsAttempted).to.equal(FUZZ_ITERATIONS,
        `Expected ${FUZZ_ITERATIONS} iterations but only completed ${totalActionsAttempted}`);

      // Final state validation
      expect(await PoPPayoutsV2Contract.owner()).to.equal(state.currentOwner);
      expect(await PoPPayoutsV2Contract.supplyOwner()).to.equal(state.currentSupplyOwner);
      expect(await PoPPayoutsV2Contract.getRoundsCount()).to.equal(state.nextRoundIndex);
    });
  });
});
