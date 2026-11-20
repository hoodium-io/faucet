import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { configureVault, devnetTokenPlans, TokenPlan } from "./lib/config";
import {
  deploymentFeeOverrides,
  MIN_DEPLOYMENT_GAS_PRICE,
} from "./lib/fees";

/**
 * Deploys the faucet stack to a Hoodium network.
 *
 * Steps:
 *   1. Refuse to run if the RPC's chain ID does not match the configured network.
 *   2. Deploy `FaucetVault(admin)`.
 *   3. Grant `DISPENSER_ROLE` to the backend hot wallet (if provided).
 *   4. Apply the per-token policy.
 *   5. Write `deployments/<network>.json` for the backend and frontend to read.
 *
 * Chain-ID verification is the important safety property: deploying a faucet to
 * the wrong chain is unrecoverable, and Hoodium's networks share the same client
 * binary and differ only by chain ID.
 *
 * MAINNET IS NOT A VALID TARGET. A faucet distributes tokens with no value; on
 * mainnet those tokens are real money. `EXPECTED_CHAIN_IDS` therefore contains
 * only devnet and testnet, and the explicit mainnet check below rejects a
 * mainnet RPC even if someone adds the network to Hardhat by hand.
 */

const EXPECTED_CHAIN_IDS: Record<string, number> = {
  hoodiumDevnet: 6592,
  hoodiumTestnet: 6591,
};

/** Hoodium mainnet EIP-155 chain ID. Present only so it can be refused. */
const MAINNET_CHAIN_ID = 6590;

async function main() {
  const netName = network.name;
  const expected = EXPECTED_CHAIN_IDS[netName];

  if (expected === undefined) {
    throw new Error(
      `Refusing to deploy: network "${netName}" is not a supported faucet network.\n` +
        `Supported: ${Object.keys(EXPECTED_CHAIN_IDS).join(", ")}\n` +
        `A faucet is only for devnet and testnet.`,
    );
  }

  // --- Step 1: verify we are on the chain we think we are on ---
  const actual = Number((await ethers.provider.getNetwork()).chainId);

  // Hard stop before anything else: never deploy a faucet that would dispense
  // real-value RUNE.
  if (actual === MAINNET_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: the RPC reports Hoodium MAINNET (chain ID ${actual}).\n` +
        `A faucet must never dispense mainnet tokens - they have real value.\n` +
        `Point HOODIUM_RPC_URL at devnet (6592) or testnet (6591).`,
    );
  }

  if (actual !== expected) {
    throw new Error(
      `Chain ID mismatch: network "${netName}" expects ${expected} but the RPC reports ${actual}.\n` +
        `Check the RPC URL in .env before deploying.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      `No signer available for "${netName}". Set HOODIUM_${netName.replace("hoodium", "").toUpperCase()}_PRIVATE_KEY in .env.`,
    );
  }

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\nHoodium faucet deployment`);
  console.log(`  network   : ${netName} (chain ID ${actual})`);
  console.log(`  deployer  : ${deployer.address}`);
  console.log(`  balance   : ${ethers.formatEther(balance)} RUNE\n`);

  if (balance === 0n) {
    throw new Error("Deployer has zero RUNE and cannot pay for gas.");
  }

  // --- Step 2: deploy the vault ---
  // Admin defaults to the deployer. In production set FAUCET_ADMIN_ADDRESS to a
  // multisig so the deploy key does not retain permanent control.
  const admin = process.env.FAUCET_ADMIN_ADDRESS || deployer.address;

  console.log(`Deploying FaucetVault (admin: ${admin})...`);

  // Hoodium charges 5e12 arune/gas for deployments but `eth_gasPrice` reports the
  // 2.5e12 regular floor, so the fee must be set explicitly or the chain rejects
  // the tx with "contract deployment requires a gas price of at least ...".
  const feeOverrides = await deploymentFeeOverrides();
  console.log(
    `  deploy fee : maxFeePerGas ${feeOverrides.maxFeePerGas.toString()} arune/gas (deployment floor ${MIN_DEPLOYMENT_GAS_PRICE})`,
  );

  const Vault = await ethers.getContractFactory("FaucetVault");
  const vault = await Vault.deploy(admin, feeOverrides);
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  console.log(`  FaucetVault -> ${vaultAddress}`);

  // --- Step 3: authorise the backend dispenser ---
  // Never derive this from the deployer key: the dispenser is a hot key and
  // must be revocable without touching custody.
  const dispenser = process.env.FAUCET_DISPENSER_ADDRESS;

  if (dispenser) {
    // Only the admin can grant roles. When the admin is a separate multisig, the
    // deployer cannot do this from a script — attempting it would revert with
    // AccessControlUnauthorizedAccount and waste gas, so bail out honestly.
    if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(
        `  SKIPPED dispenser grant: admin is ${admin}, not the deployer.\n` +
          `          Grant it from the admin account instead:\n` +
          `          grantRole(DISPENSER_ROLE, ${dispenser})`,
      );
    } else {
      const role = await vault.DISPENSER_ROLE();
      const tx = await vault.grantRole(role, dispenser);
      await tx.wait();
      console.log(`  DISPENSER_ROLE -> ${dispenser}`);
    }
  } else {
    console.log(`  WARNING: FAUCET_DISPENSER_ADDRESS not set.`);
    console.log(`           The backend cannot dispense until you run:`);
    console.log(`           npm run grant-dispenser:devnet`);
  }

  // --- Step 4: apply the token policy ---
  // `setTokenConfig` is admin-only, so it can only be applied from a script when
  // the deployer *is* the admin. With a multisig admin, policy is applied from
  // the admin account afterwards (see the printed instructions).
  if (admin.toLowerCase() === deployer.address.toLowerCase()) {
    console.log(`\nConfiguring token policy:`);
    const plans: TokenPlan[] = devnetTokenPlans(
      Number(process.env.FAUCET_NATIVE_DRIP || "1"),
    );
    await configureVault(vaultAddress, plans);
  } else {
    console.log(
      `\nSKIPPED token policy: admin is ${admin}, so setTokenConfig must be called\n` +
        `from the admin account. Nothing will be dispensable until it is.`,
    );
  }

  const plans: TokenPlan[] = devnetTokenPlans(Number(process.env.FAUCET_NATIVE_DRIP || "1"));

  // --- Step 5: persist addresses for the backend and frontend ---
  const deployment = {
    network: netName,
    chainId: actual,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin,
    dispenser: dispenser || null,
    contracts: {
      FaucetVault: vaultAddress,
    },
    tokens: plans.map((p) => ({
      label: p.label,
      address: p.address,
      decimals: p.decimals,
      drip: p.drip,
      cooldown: p.cooldown,
      dailyCap: p.dailyCap,
      enabled: p.enabled,
    })),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${netName}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log(`\nWrote ${path.relative(process.cwd(), outFile)}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Fund the vault:  depositNative() / depositERC20()`);
  console.log(`  2. Backend .env:    FAUCET_VAULT_ADDRESS=${vaultAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
