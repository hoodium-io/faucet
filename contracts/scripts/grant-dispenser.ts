import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Grants `DISPENSER_ROLE` on the vault to the backend's hot account.
 *
 * Exists as a separate script so custody (admin) and signing (dispenser) never
 * share a key. Run it whenever the backend account rotates:
 *
 *   1. grant to the new dispenser
 *   2. deploy the backend with the new key
 *   3. revoke from the old dispenser (`revoke-role` below)
 *
 * Usage:
 *   FAUCET_DISPENSER_ADDRESS=0x... npm run grant-dispenser:devnet
 */
async function main() {
  const netName = network.name;
  const file = path.join(__dirname, "..", "deployments", `${netName}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run: npm run deploy:devnet`);
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const vaultAddress: string = deployment.contracts.FaucetVault;

  const dispenser = process.env.FAUCET_DISPENSER_ADDRESS;
  if (!dispenser || !ethers.isAddress(dispenser)) {
    throw new Error(
      "Set FAUCET_DISPENSER_ADDRESS to a valid address.\n" +
        "  FAUCET_DISPENSER_ADDRESS=0x... npm run grant-dispenser:devnet",
    );
  }

  const [admin] = await ethers.getSigners();
  const vault = await ethers.getContractAt("FaucetVault", vaultAddress);
  const role = await vault.DISPENSER_ROLE();

  const already = await vault.hasRole(role, dispenser);
  if (already) {
    console.log(`${dispenser} already holds DISPENSER_ROLE. Nothing to do.`);
    return;
  }

  console.log(`Granting DISPENSER_ROLE to ${dispenser}`);
  console.log(`  vault : ${vaultAddress}`);
  console.log(`  signer: ${admin.address}`);

  const tx = await vault.grantRole(role, dispenser);
  await tx.wait();
  console.log(`  done: ${tx.hash}`);

  deployment.dispenser = dispenser;
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
