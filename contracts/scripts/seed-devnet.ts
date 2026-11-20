import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { NATIVE_TOKEN, toBaseUnits } from "./lib/config";
import { deploymentFeeOverrides } from "./lib/fees";

/**
 * Funds the faucet vault with inventory on a devnet/testnet.
 *
 * Two modes:
 *
 *   A) Seed an existing deployment (default)
 *      Reads `deployments/<network>.json` and deposits native RUNE when
 *      FAUCET_SEED_NATIVE_RUNE > 0.
 *
 *   B) Deploy fresh mock tokens first (FAUCET_SEED_DEPLOY_MOCKS=true)
 *      Deploys `MockERC20` contracts, mints supply to the treasury, deposits
 *      into the vault and registers the token policy. Use this on a brand-new
 *      devnet where no spendable ERC-20 exists yet.
 *
 * The treasury is the signing account. It must hold `TREASURER_ROLE` on the
 * vault (the deployer is the default admin, so this holds out of the box).
 */

interface DeploymentToken {
  label: string;
  address: string;
  decimals: number;
  drip: number;
  cooldown: number;
  dailyCap: number;
  enabled: boolean;
}

interface DeploymentFile {
  network: string;
  chainId: number;
  contracts: { FaucetVault: string };
  tokens: DeploymentToken[];
}

interface MockSpec {
  name: string;
  symbol: string;
  decimals: number;
  /** Supply minted to the treasury, in whole units. */
  supply: number;
  /** Amount deposited into the vault, in whole units. */
  deposit: number;
}

function readDeployment(netName: string): DeploymentFile {
  const file = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}.\nRun: npm run deploy:devnet`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentFile;
}

/** Default mock tokens seeded on a fresh devnet. */
function defaultMocks(): MockSpec[] {
  return [
    { name: "Mock USD", symbol: "mUSD", decimals: 18, supply: 1_000_000, deposit: 250_000 },
    { name: "Mock HOODI", symbol: "mHOODI", decimals: 18, supply: 1_000_000, deposit: 250_000 },
  ];
}

/** Parses FAUCET_SEED_ERC20 as a JSON array of MockSpec. */
function parseMockSpecs(): MockSpec[] | null {
  const raw = process.env.FAUCET_SEED_ERC20;
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed as MockSpec[];
}

/**
 * The slice of `FaucetVault` that `seedMock` needs.
 *
 * Typed structurally rather than as `Contract`: `getContractAt` returns a
 * typechain-generated `FaucetVault`, which is NOT assignable to ethers' bare
 * `Contract` (it lacks the string index signature). Narrowing to the two methods
 * actually used keeps this decoupled from both.
 */
interface VaultSeeder {
  depositERC20(token: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
  setTokenConfig(
    token: string,
    cfg: {
      enabled: boolean;
      dripAmount: bigint;
      maxDispense: bigint;
      cooldown: number;
      dailyCap: bigint;
    },
  ): Promise<{ wait(): Promise<unknown> }>;
}

/** Deploys a MockERC20, deposits inventory and registers its policy. */
async function seedMock(
  spec: MockSpec,
  vault: VaultSeeder,
  vaultAddress: string,
  treasury: string,
): Promise<DeploymentToken> {
  console.log(`\nDeploying ${spec.symbol} (${spec.name}, ${spec.decimals} decimals)...`);

  const supply = toBaseUnits(spec.supply, spec.decimals);
  const Mock = await ethers.getContractFactory("MockERC20");

  // MockERC20 is a deployment too (empty `to`), so it needs the higher 5e12 floor.
  const feeOverrides = await deploymentFeeOverrides();

  const token = await Mock.deploy(
    spec.name,
    spec.symbol,
    spec.decimals,
    supply,
    supply, // cap == supply mimics a fixed-supply real asset
    treasury,
    feeOverrides,
  );
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  console.log(`  ${spec.symbol} -> ${tokenAddress} (minted ${spec.supply} to treasury)`);

  const deposit = toBaseUnits(spec.deposit, spec.decimals);
  await (await token.approve(vaultAddress, deposit)).wait();
  await (await vault.depositERC20(tokenAddress, deposit)).wait();
  console.log(`  deposited ${spec.deposit} ${spec.symbol}`);

  const cfg = {
    enabled: true,
    dripAmount: toBaseUnits(100, spec.decimals),
    maxDispense: toBaseUnits(100, spec.decimals),
    cooldown: 24 * 60 * 60,
    dailyCap: toBaseUnits(10_000, spec.decimals),
  };
  await (await vault.setTokenConfig(tokenAddress, cfg)).wait();
  console.log(`  policy set: drip=100 cooldown=24h cap=10000`);

  return {
    label: spec.symbol,
    address: tokenAddress,
    decimals: spec.decimals,
    drip: 100,
    cooldown: 24 * 60 * 60,
    dailyCap: 10_000,
    enabled: true,
  };
}

async function main() {
  const deployment = readDeployment(network.name);
  const [treasury] = await ethers.getSigners();
  const vaultAddress = deployment.contracts.FaucetVault;

  console.log(`\nSeeding vault ${vaultAddress} on ${network.name}`);
  console.log(`  treasury: ${treasury.address}`);
  console.log(
    `  balance : ${ethers.formatEther(await ethers.provider.getBalance(treasury.address))} RUNE\n`,
  );

  const vault = await ethers.getContractAt("FaucetVault", vaultAddress);

  // --- Native RUNE ---
  const nativeAmount = Number(process.env.FAUCET_SEED_NATIVE_RUNE || "0");
  if (nativeAmount > 0) {
    const value = toBaseUnits(nativeAmount, 18);
    console.log(`Depositing ${nativeAmount} RUNE (native)...`);
    const tx = await vault.depositNative({ value });
    await tx.wait();
    console.log(`  done: ${tx.hash}`);
  } else {
    console.log(`Skipping native RUNE (FAUCET_SEED_NATIVE_RUNE unset or 0).`);
  }

  // --- ERC-20 inventory ---
  if (process.env.FAUCET_SEED_DEPLOY_MOCKS === "true") {
    const mocks = parseMockSpecs() ?? defaultMocks();

    for (const spec of mocks) {
      // Skip tokens that are already registered so re-runs are idempotent.
      const exists = deployment.tokens.some(
        (t) => t.label.toUpperCase() === spec.symbol.toUpperCase(),
      );
      if (exists) {
        console.log(`\nSkipping ${spec.symbol}: already in the deployment file.`);
        continue;
      }
      deployment.tokens.push(await seedMock(spec, vault, vaultAddress, treasury.address));
    }
  } else if (deployment.tokens.some((t) => t.address !== NATIVE_TOKEN)) {
    console.log(
      `\nERC-20 tokens exist but were not deposited. Set FAUCET_SEED_DEPLOY_MOCKS=true to\n` +
        `create mock inventory, or deposit manually with depositERC20().`,
    );
  } else {
    console.log(
      `\nNo ERC-20 tokens configured. Re-run with FAUCET_SEED_DEPLOY_MOCKS=true to create mock inventory.`,
    );
  }

  // Persist newly discovered token addresses.
  const outFile = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log(`\nVault inventory after seeding:`);
  for (const token of deployment.tokens) {
    const held = await vault.inventory(token.address);
    console.log(`  ${token.label.padEnd(10)} ${ethers.formatUnits(held, token.decimals)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
