import { ethers } from "hardhat";

/**
 * Fee overrides for Hoodium transactions.
 *
 * Hoodium charges TWO minimum gas prices (see the chain's
 * `app/ante/evm/deployment_fee.go` and `docs/tx-fees.md`):
 *
 *   regular tx      : 2.5e12 arune/gas
 *   contract deploy : 5e12   arune/gas   (2× the regular floor)
 *
 * `eth_gasPrice` on the devnet returns exactly the REGULAR floor (2.5e12), so
 * ethers/Hardhat auto-fills 2.5e12 for every transaction. Deployments then fail:
 *
 *   contract deployment requires a gas price of at least 5000000000000,
 *   got 2500000000000
 *
 * ── The subtlety that cost two attempts ──────────────────────────────────────
 * The floor is checked against the **effective** price, which for a dynamic-fee
 * (EIP-1559) transaction is:
 *
 *     effective = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)
 *
 * Raising only `maxFeePerGas` while leaving the tip at 0 renders that
 *
 *     min(5e12, 2e10 + 0) = 2e10
 *
 * so the chain reports "got 20000000000" — the base fee, not the max fee. Both
 * failures were observed on the live devnet and are explained by this formula;
 * it is the only formula consistent with both.
 *
 * Therefore the floor must be expressed in the **tip**, with `maxFeePerGas` high
 * enough to accommodate it on top of the base fee.
 */

/** Documented defaults, in arune per gas. */
export const MIN_REGULAR_GAS_PRICE = 2_500_000_000_000n; // 2.5e12
export const MIN_DEPLOYMENT_GAS_PRICE = 5_000_000_000_000n; // 5e12

/** Live base fee from the latest block (arune per gas). */
export async function currentBaseFee(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  // Pre-London blocks (or a chain with the fee market disabled) have no base fee.
  return block?.baseFeePerGas ?? 0n;
}

/**
 * Builds overrides that guarantee `min(maxFee, baseFee + tip) >= floor`.
 *
 * Strategy: put the whole floor in the tip, and set `maxFeePerGas` to
 * `floor + baseFee` so the cap can never bind below the floor even if the base
 * fee rises between estimation and inclusion.
 */
async function feeOverridesForFloor(floor: bigint): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const baseFee = await currentBaseFee();

  return {
    // effective = min(maxFee, baseFee + tip); with tip == floor this is
    // baseFee + floor, which is >= floor for any baseFee >= 0.
    maxPriorityFeePerGas: floor,
    // Headroom for a base-fee rise without making the cap absurd.
    maxFeePerGas: floor + baseFee,
  };
}

/**
 * Fee overrides for a CONTRACT DEPLOYMENT (empty `to`).
 *
 * MUST be passed to any `ContractFactory.deploy(...)`.
 */
export async function deploymentFeeOverrides(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  return feeOverridesForFloor(MIN_DEPLOYMENT_GAS_PRICE);
}

/**
 * Fee overrides for a REGULAR transaction (transfer or contract call).
 *
 * Hardhat's auto-fill already clears the regular floor on this chain, so these are
 * a safety net — they keep call paths symmetric with deploys and immune to a chain
 * whose `eth_gasPrice` under-reports.
 */
export async function regularFeeOverrides(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  return feeOverridesForFloor(MIN_REGULAR_GAS_PRICE);
}
