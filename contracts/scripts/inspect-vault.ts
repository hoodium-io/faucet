import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Prints the live state of a deployed vault so operators can confirm inventory,
 * policy and pause status without reading the chain by hand.
 */
async function main() {
  const netName = network.name;
  const file = path.join(__dirname, "..", "deployments", `${netName}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run: npm run deploy:devnet`);
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const vaultAddress: string = deployment.contracts.FaucetVault;
  const vault = await ethers.getContractAt("FaucetVault", vaultAddress);

  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log(`\nFaucetVault ${vaultAddress}`);
  console.log(`  network          : ${netName} (chain ID ${chainId})`);
  console.log(`  paused           : ${await vault.paused()}`);
  console.log(`  uniqueRecipients : ${await vault.uniqueRecipients()}`);
  console.log(`  addressCooldown  : ${await vault.addressCooldown()}s`);

  const dispenserRole = await vault.DISPENSER_ROLE();
  if (deployment.dispenser) {
    const has = await vault.hasRole(dispenserRole, deployment.dispenser);
    console.log(`  dispenser        : ${deployment.dispenser} (role: ${has ? "yes" : "NO"})`);
  } else {
    console.log(`  dispenser        : not set`);
  }

  const tokens: string[] = await vault.acceptedTokens();
  console.log(`\nAccepted tokens (${tokens.length}):`);

  for (const token of tokens) {
    const status = await vault.tokenStatus(token);
    const cfg = status.cfg ?? status[0];
    const available = status.available ?? status[1];
    const dispensedToday = status.dispensedToday ?? status[2];
    const remainingToday = status.remainingToday ?? status[3];

    const meta = deployment.tokens?.find(
      (t: { address: string }) => t.address.toLowerCase() === token.toLowerCase(),
    );
    const decimals = meta?.decimals ?? 18;
    const label = meta?.label ?? token;

    const fmt = (v: bigint) => ethers.formatUnits(v, decimals);

    console.log(`\n  ${label}`);
    console.log(`    address        : ${token}`);
    console.log(`    enabled        : ${cfg.enabled}`);
    console.log(`    inventory      : ${fmt(available)}`);
    console.log(`    drip           : ${fmt(cfg.dripAmount)}`);
    console.log(`    maxDispense    : ${fmt(cfg.maxDispense)}`);
    console.log(`    cooldown       : ${cfg.cooldown}s`);
    console.log(
      `    dailyCap       : ${cfg.dailyCap === 0n ? "uncapped" : fmt(cfg.dailyCap)}`,
    );
    console.log(`    dispensedToday : ${fmt(dispensedToday)}`);
    console.log(
      `    remainingToday : ${cfg.dailyCap === 0n ? "uncapped" : fmt(remainingToday)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
