import { ethers, network } from "hardhat";
import { regularFeeOverrides } from "./lib/fees";

/**
 * Sends native RUNE from the deployer to the dispenser account.
 *
 * WHY THIS IS NEEDED: the dispenser holds `DISPENSER_ROLE` and signs every claim,
 * so it must pay gas — but it is a freshly generated key with a zero balance. A
 * vault that is deployed, funded and correctly configured will still reject every
 * claim with "insufficient funds" if this step is skipped. Because the deploy
 * appears to succeed, the failure only shows up on the first user claim.
 *
 * Idempotent: does nothing if the dispenser is already funded above the dust
 * threshold, unless `FAUCET_FUND_FORCE=true`.
 *
 * Env:
 *   FAUCET_FUND_ADDRESS  the dispenser address (required)
 *   FAUCET_FUND_RUNE     amount in whole RUNE (default 10)
 *   FAUCET_FUND_FORCE    "true" to send even when already funded
 */
async function main() {
  const to = process.env.FAUCET_FUND_ADDRESS;
  const amountRune = process.env.FAUCET_FUND_RUNE || "10";
  const force = process.env.FAUCET_FUND_FORCE === "true";

  if (!to || !ethers.isAddress(to)) {
    throw new Error("Set FAUCET_FUND_ADDRESS to a valid address.");
  }

  const [deployer] = await ethers.getSigners();
  const amount = ethers.parseEther(amountRune);

  const [deployerBal, currentBal] = await Promise.all([
    ethers.provider.getBalance(deployer.address),
    ethers.provider.getBalance(to),
  ]);

  console.log(`  from       : ${deployer.address}`);
  console.log(`  to         : ${to}`);
  console.log(`  current    : ${ethers.formatEther(currentBal)} RUNE`);

  // "Funded" means it can already pay for many claims. 1 RUNE covers ~19 plain
  // transfers at the devnet floor, so treat anything above that as sufficient.
  const dustThreshold = ethers.parseEther("1");
  if (currentBal >= dustThreshold && !force) {
    console.log(`  already above 1 RUNE — nothing to do (set FAUCET_FUND_FORCE=true to override).`);
    return;
  }

  if (deployerBal <= amount) {
    throw new Error(
      `Deployer has ${ethers.formatEther(deployerBal)} RUNE, which cannot cover ${amountRune} RUNE + gas.`,
    );
  }

  console.log(`  sending    : ${amountRune} RUNE`);

  // Regular transaction (populated `to`), so the 2.5e12 regular floor applies.
  // The tip must carry the floor — see scripts/lib/fees.ts.
  const tx = await deployer.sendTransaction({
    to,
    value: amount,
    ...(await regularFeeOverrides()),
  });

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Funding transaction failed.");
  }

  const after = await ethers.provider.getBalance(to);
  console.log(`  done       : ${tx.hash}`);
  console.log(`  new balance: ${ethers.formatEther(after)} RUNE`);
  console.log(`  network    : ${network.name}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
