import { ethers } from "hardhat";

/** Native-token sentinel used by the vault for the chain's gas token (RUNE). */
export const NATIVE_TOKEN = ethers.ZeroAddress;

/**
 * Per-network faucet policy.
 *
 * Amounts are expressed in **whole token units** and converted with the token's
 * own decimals, because a faucet config that hard-codes base units is a reliable
 * source of 10^12-scale mistakes. Hoodium's native RUNE has 18 decimals
 * (verified on the live devnet: `RUNE.decimals() == 18`).
 */
export interface TokenPlan {
  /** Human label shown in the UI and logs. */
  label: string;
  /** ERC-20 address, or NATIVE_TOKEN for native RUNE. */
  address: string;
  /** Token decimals, used to scale the whole-unit amounts below. */
  decimals: number;
  /** Amount handed out per claim, in whole units. */
  drip: number;
  /** Ceiling for a single dispense, in whole units. */
  maxDispense: number;
  /** Per-recipient cooldown in seconds. */
  cooldown: number;
  /** Rolling 24h cap in whole units. `0` disables the cap. */
  dailyCap: number;
  /** Whether dispensing starts enabled. */
  enabled: boolean;
}

/** Converts whole units to base units without floating-point error. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  return ethers.parseUnits(amount.toString(), decimals);
}

/**
 * Default devnet policy.
 *
 * Rationale for the numbers:
 * - RUNE drip is sized to comfortably cover gas for many transactions. At the
 *   devnet regular floor of 0.0000025 RUNE/gas, a 21,000-gas transfer costs
 *   ~0.0525 RUNE, so 1 RUNE is roughly 19 plain transfers.
 * - Cooldown is 24h per token, matching the UI copy and the original spec.
 * - `dailyCap` is deliberately finite so a sybil run cannot drain the vault in
 *   one day even if every IP check is bypassed.
 */
export function devnetTokenPlans(nativeDrip = 1): TokenPlan[] {
  return [
    {
      label: "RUNE (native gas token)",
      address: NATIVE_TOKEN,
      decimals: 18,
      drip: nativeDrip,
      maxDispense: nativeDrip,
      cooldown: 24 * 60 * 60,
      dailyCap: 500,
      enabled: true,
    },
  ];
}

/**
 * Applies `plans` to the vault. Each plan becomes one `setTokenConfig` call.
 * Returns the token addresses in the order they were configured.
 */
export async function configureVault(
  vaultAddress: string,
  plans: TokenPlan[],
): Promise<string[]> {
  const vault = await ethers.getContractAt("FaucetVault", vaultAddress);

  for (const plan of plans) {
    const cfg = {
      enabled: plan.enabled,
      dripAmount: toBaseUnits(plan.drip, plan.decimals),
      maxDispense: toBaseUnits(plan.maxDispense, plan.decimals),
      cooldown: plan.cooldown,
      dailyCap: toBaseUnits(plan.dailyCap, plan.decimals),
    };

    const tx = await vault.setTokenConfig(plan.address, cfg);
    await tx.wait();

    console.log(
      `  configured ${plan.label.padEnd(28)} drip=${plan.drip} cooldown=${plan.cooldown}s cap=${plan.dailyCap}`,
    );
  }

  return plans.map((p) => p.address);
}
