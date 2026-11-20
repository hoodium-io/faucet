import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { toBaseUnits } from "./lib/config";
import { regularFeeOverrides } from "./lib/fees";

/**
 * Adds an EXISTING ERC-20 to the faucet — no mock deployment.
 *
 * This is the production path. Hoodium Devnet already has real tokens:
 *
 *   HOODI  0x19bE000000000000000000000000000000000001  (native precompile, 18dp,
 *                                                       full ERC-20 incl. approve)
 *   RUNE   0x19be000000000000000000000000000000000000  (gas token precompile)
 *
 * `MockERC20` exists only for a bare chain with no assets. On a public faucet you
 * want the real token, so this script:
 *
 *   1. reads the token's own decimals/symbol/name on-chain (no guessing)
 *   2. approves the vault to pull `amount`
 *   3. calls `vault.depositERC20(token, amount)`
 *   4. registers/updates the token policy via `setTokenConfig`
 *   5. records the token in `deployments/<network>.json`
 *
 * Usage:
 *   TOKEN_ADDRESS=0x19bE...0001 TOKEN_DEPOSIT=1000 TOKEN_DRIP=5 \
 *     npx hardhat run scripts/add-token.ts --network hoodiumDevnet
 *
 * Env:
 *   TOKEN_ADDRESS    required — the ERC-20 to accept
 *   TOKEN_DECIMALS   optional — read on-chain when omitted
 *   TOKEN_DEPOSIT    whole units to deposit now (default 0 = policy only)
 *   TOKEN_DRIP       whole units per claim (default 1)
 *   TOKEN_MAX        whole units ceiling per dispense (default = TOKEN_DRIP)
 *   TOKEN_COOLDOWN   seconds between claims (default 86400)
 *   TOKEN_DAILY_CAP  whole units per rolling 24h; 0 = uncapped (default 0)
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

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function readDeployment(netName: string): { file: string; data: DeploymentFile } {
  const file = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run deploy:devnet first.`);
  }
  return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentFile };
}

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to a valid ERC-20 address.");
  }

  const { file, data: deployment } = readDeployment(network.name);
  const vaultAddress = deployment.contracts.FaucetVault;
  const [treasury] = await ethers.getSigners();

  const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, treasury);

  console.log(`\nAdding ${tokenAddress} to faucet ${vaultAddress}`);
  console.log(`  network  : ${network.name}`);
  console.log(`  treasury : ${treasury.address}`);

  // --- 1. Read the token's own metadata; never assume decimals -----------------
  let symbol = "UNKNOWN";
  let name = "Unknown Token";
  let decimals = Number(process.env.TOKEN_DECIMALS || "0");

  try {
    [symbol, name] = await Promise.all([token.symbol(), token.name()]);
  } catch {
    console.log(`  warning  : token does not expose symbol()/name(); using defaults`);
  }

  if (!decimals) {
    try {
      decimals = Number(await token.decimals());
    } catch {
      throw new Error("Token does not expose decimals(); set TOKEN_DECIMALS explicitly.");
    }
  }

  console.log(`  token    : ${symbol} (${name}) · ${decimals} decimals`);

  // --- 2. Policy --------------------------------------------------------------
  const drip = Number(process.env.TOKEN_DRIP || "1");
  const maxDispense = Number(process.env.TOKEN_MAX || String(drip));
  const cooldown = Number(process.env.TOKEN_COOLDOWN || String(24 * 60 * 60));
  const dailyCap = Number(process.env.TOKEN_DAILY_CAP || "0");

  if (maxDispense < drip) {
    throw new Error(`TOKEN_MAX (${maxDispense}) must be >= TOKEN_DRIP (${drip}).`);
  }

  const vault = await ethers.getContractAt("FaucetVault", vaultAddress);

  // --- 3. Deposit inventory (optional) ---------------------------------------
  const deposit = Number(process.env.TOKEN_DEPOSIT || "0");

  if (deposit > 0) {
    const amount = toBaseUnits(deposit, decimals);

    const held = (await token.balanceOf(treasury.address)) as bigint;
    if (held < amount) {
      throw new Error(
        `Treasury holds ${ethers.formatUnits(held, decimals)} ${symbol}, ` +
          `cannot deposit ${deposit}.`,
      );
    }

    const allowance = (await token.allowance(treasury.address, vaultAddress)) as bigint;
    if (allowance < amount) {
      console.log(`  approving: ${deposit} ${symbol}`);
      const approveTx = await token.approve(vaultAddress, amount, {
        ...(await regularFeeOverrides()),
      });
      await approveTx.wait();
    }

    console.log(`  depositing: ${deposit} ${symbol}`);
    const depositTx = await vault.depositERC20(tokenAddress, amount);
    await depositTx.wait();
    console.log(`  done     : ${depositTx.hash}`);
  } else {
    console.log(`  deposit  : skipped (TOKEN_DEPOSIT unset or 0)`);
  }

  // --- 4. Register the policy -------------------------------------------------
  const cfg = {
    enabled: true,
    dripAmount: toBaseUnits(drip, decimals),
    maxDispense: toBaseUnits(maxDispense, decimals),
    cooldown,
    dailyCap: toBaseUnits(dailyCap, decimals),
  };

  console.log(
    `  policy   : drip=${drip} max=${maxDispense} cooldown=${cooldown}s cap=${dailyCap || "uncapped"}`,
  );
  const cfgTx = await vault.setTokenConfig(tokenAddress, cfg);
  await cfgTx.wait();
  console.log(`  done     : ${cfgTx.hash}`);

  // --- 5. Record it -----------------------------------------------------------
  const existing = deployment.tokens.find(
    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  const entry: DeploymentToken = {
    label: symbol,
    address: tokenAddress,
    decimals,
    drip,
    cooldown,
    dailyCap,
    enabled: true,
  };

  if (existing) Object.assign(existing, entry);
  else deployment.tokens.push(entry);

  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`  recorded : ${path.relative(process.cwd(), file)}`);

  // --- Summary ----------------------------------------------------------------
  const status = await vault.tokenStatus(tokenAddress);
  console.log(`\n${symbol} is now dispensable:`);
  console.log(`  inventory : ${ethers.formatUnits(status.available, decimals)}`);
  console.log(`  drip      : ${ethers.formatUnits(status.cfg.dripAmount, decimals)} per claim`);
  const remaining =
    status.cfg.dailyCap === 0n
      ? "uncapped"
      : `${ethers.formatUnits(status.remainingToday, decimals)} today`;
  console.log(`  remaining : ${remaining}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
