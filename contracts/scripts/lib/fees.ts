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
 * ethers/Hardhat auto-fills 2.5e12 for every transaction. Deployments then fail
 * with:
 *
 *   contract deployment requires a gas price of at least 5000000000000 ...,
 *   got 2500000000000 ...
 *
 * So any transaction with an empty `to` (a deployment) must override the fee
 * explicitly. These helpers read the live floors from the chain where possible and
 * fall back to the documented defaults.
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
 * Fee overrides for a CONTRACT DEPLOYMENT (empty `to`).
 *
 * MUST be passed to any `ContractFactory.deploy(...)`; otherwise Hardhat fills the
 * regular floor and the chain rejects the tx.
 *
 * Shape: EIP-1559 with `maxFeePerGas` at the deployment floor and a zero priority
 * tip, so `maxFee >= baseFee` holds trivially while the effective price still
 * clears 5e12.
 */
export async function deploymentFeeOverrides(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const baseFee = await currentBaseFee();

  // The floor is a floor on the effective price. With a zero tip the effective
  // price is min(baseFee + 0, maxFee) = maxFee when baseFee <= maxFee, which is
  // the normal case (baseFee ~2e10 vs floor 5e12).
  const maxFeePerGas = MIN_DEPLOYMENT_GAS_PRICE > baseFee ? MIN_DEPLOYMENT_GAS_PRICE : baseFee;

  return { maxFeePerGas, maxPriorityFeePerGas: 0n };
}

/**
 * Fee overrides for a REGULAR transaction (transfer or contract call).
 *
 * `eth_gasPrice` already returns the regular floor, so these are mostly a
 * no-op — but being explicit keeps deploy and call paths symmetric and immune to
 * a chain whose `eth_gasPrice` under-reports.
 */
export async function regularFeeOverrides(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const baseFee = await currentBaseFee();
  const maxFeePerGas =
    MIN_REGULAR_GAS_PRICE > baseFee ? MIN_REGULAR_GAS_PRICE : baseFee;

  return { maxFeePerGas, maxPriorityFeePerGas: 0n };
}
