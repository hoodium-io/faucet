import {
  Contract,
  JsonRpcProvider,
  Wallet,
  isAddress,
  getAddress,
  parseUnits,
  formatUnits,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
} from "ethers";
import type { AppConfig } from "../config";
import { MAINNET_CHAIN_ID } from "../config";
import { TxQueue } from "../lib/tx-queue";

/**
 * Minimal ABI for the parts of `FaucetVault` the backend touches.
 *
 * Hand-written rather than generated so the backend has no build-time
 * dependency on the Hardhat artifacts. Kept deliberately small: the backend only
 * reads policy/inventory and dispenses.
 */
export const FAUCET_VAULT_ABI = [
  "function dispense(address token, address recipient, uint256 amount) returns (uint256)",
  "function tokenConfig(address token) view returns (bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap)",
  "function acceptedTokens() view returns (address[])",
  "function inventory(address token) view returns (uint256)",
  "function tokenStatus(address token) view returns (tuple(bool enabled, uint256 dripAmount, uint256 maxDispense, uint32 cooldown, uint256 dailyCap) cfg, uint256 available, uint256 dispensedToday, uint256 remainingToday)",
  "function claimableAt(address token, address recipient) view returns (bool allowed, uint256 availableAt)",
  "function lastClaimAt(address token, address recipient) view returns (uint256)",
  "function paused() view returns (bool)",
  "function NATIVE_TOKEN() view returns (address)",
  "function DISPENSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event Dispensed(address indexed token, address indexed recipient, uint256 amount, address indexed operator)",
] as const;

/** Thrown when a claim cannot be served for a reportable reason. */
export class FaucetError extends Error {
  constructor(
    /** HTTP status the API should return. */
    public readonly status: number,
    /** Stable machine-readable code for the frontend. */
    public readonly code: string,
    message: string,
    /** Extra structured detail (e.g. retryAfter seconds). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FaucetError";
  }
}

/** Public description of one accepted token. */
export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isNative: boolean;
  enabled: boolean;
  /** Drip amount in whole units, as a decimal string. */
  drip: string;
  cooldownSeconds: number;
  /** Inventory held by the vault, in whole units. */
  inventory: string;
  /** Inventory is below one drip: claims will fail. */
  lowInventory: boolean;
}

/** Successful claim result. */
export interface ClaimResult {
  txHash: string;
  token: string;
  amount: string;
  recipient: string;
  blockNumber: number | null;
}

/** A token's policy, as decoded from `tokenConfig` / `tokenStatus().cfg`. */
export interface VaultTokenConfig {
  enabled: boolean;
  dripAmount: bigint;
  maxDispense: bigint;
  cooldown: bigint;
  dailyCap: bigint;
}

/**
 * Typed view of the `FaucetVault` methods the backend calls.
 *
 * WHY THIS EXISTS: `ethers.Contract` exposes dynamic members as effectively
 * `any`-typed `ContractMethod | undefined`. Under `strict` +
 * `noUncheckedIndexedAccess` every `contract.someMethod()` then fails with TS2722
 * ("Cannot invoke an object which is possibly 'undefined'") — and, worse, nothing
 * is actually type-checked. Declaring the surface explicitly fixes all of that and
 * gives real return types.
 *
 * Keep in sync with `FAUCET_VAULT_ABI` below, which mirrors
 * `contracts/contracts/FaucetVault.sol` (verified by `npm run verify:abi` there).
 */
export interface FaucetVaultContract {
  // --- Views ---
  DISPENSER_ROLE(): Promise<string>;
  hasRole(role: string, account: string): Promise<boolean>;
  paused(): Promise<boolean>;
  NATIVE_TOKEN(): Promise<string>;
  acceptedTokens(): Promise<string[]>;
  inventory(token: string): Promise<bigint>;
  tokenStatus(token: string): Promise<{
    cfg: VaultTokenConfig;
    available: bigint;
    dispensedToday: bigint;
    remainingToday: bigint;
  }>;
  claimableAt(token: string, recipient: string): Promise<[boolean, bigint]>;

  // --- State-changing ---
  dispense(
    token: string,
    recipient: string,
    amount: bigint,
    overrides?: Record<string, unknown>,
  ): Promise<ContractTransactionResponse>;
}

/** Typed view of the ERC-20 metadata calls used for token display. */
export interface Erc20MetadataContract {
  symbol(): Promise<string>;
  name(): Promise<string>;
  decimals(): Promise<bigint>;
}

/**
 * All chain interaction lives here.
 *
 * Design notes:
 * - The dispenser key can ONLY call `dispense`. It cannot mint, withdraw or
 *   change policy — those require `TREASURER_ROLE`/`DEFAULT_ADMIN_ROLE`, which
 *   the backend never holds.
 * - Transactions are serialised through `TxQueue` so nonces stay correct.
 * - Failures are translated into `FaucetError` with an HTTP status, decoding
 *   on-chain custom errors so users see "cooldown active" instead of a revert
 *   blob.
 */
export class VaultService {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly vault: FaucetVaultContract;
  private readonly queue = new TxQueue();

  constructor(private readonly config: AppConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl, config.network.chainId, {
      // Static network avoids a redundant chainId probe per call.
      staticNetwork: true,
    });

    this.wallet = new Wallet(config.dispenserPrivateKey, this.provider);
    // The ABI drives the runtime dispatch; the cast only attaches the static
    // surface declared in `FaucetVaultContract`.
    this.vault = new Contract(config.vaultAddress, FAUCET_VAULT_ABI, this.wallet) as unknown as
      FaucetVaultContract;
  }

  /** Address of the backend's signing account. */
  get dispenserAddress(): string {
    return this.wallet.address;
  }

  /**
   * Verifies the RPC chain ID matches the configured network.
   *
   * Also refuses mainnet outright. The enum and network table already exclude
   * it, so this is defence in depth: if `HOODIUM_RPC_URL` is pointed at mainnet
   * while the config says devnet, the mismatch is caught here — and if the chain
   * *is* mainnet, the dispenser key is never used.
   */
  async assertCorrectChain(): Promise<number> {
    const onChain = Number((await this.provider.getNetwork()).chainId);

    if (onChain === MAINNET_CHAIN_ID) {
      throw new FaucetError(
        500,
        "MAINNET_REFUSED",
        `RPC reports Hoodium MAINNET (chain ID ${onChain}). A faucet must never dispense mainnet tokens.`,
      );
    }

    if (onChain !== this.config.network.chainId) {
      throw new FaucetError(
        500,
        "WRONG_CHAIN",
        `RPC reports chain ID ${onChain} but ${this.config.network.name} expects ${this.config.network.chainId}.`,
      );
    }

    return onChain;
  }

  /** Verifies the dispenser key actually holds DISPENSER_ROLE. */
  async assertDispenserAuthorised(): Promise<boolean> {
    const role = (await this.vault.DISPENSER_ROLE()) as string;
    return (await this.vault.hasRole(role, this.wallet.address)) as boolean;
  }

  /** Whether dispensing is currently paused on-chain. */
  async isPaused(): Promise<boolean> {
    return (await this.vault.paused()) as boolean;
  }

  /** The vault's sentinel address for the native gas token. */
  async nativeTokenAddress(): Promise<string> {
    return (await this.vault.NATIVE_TOKEN()) as string;
  }

  /** Native RUNE balance of the dispenser, used to warn about gas. */
  async dispenserGasBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  /** Reads symbol/name/decimals, tolerating non-standard tokens. */
  private async readTokenMeta(
    address: string,
    isNative: boolean,
  ): Promise<{ symbol: string; name: string; decimals: number }> {
    if (isNative) {
      return {
        // Hoodium's native gas token; 18 decimals verified on the live chain
        // (RUNE precompile `decimals()` returns 18).
        symbol: this.config.network.nativeCurrency.symbol,
        name: this.config.network.nativeCurrency.name,
        decimals: this.config.network.nativeCurrency.decimals,
      };
    }

    const erc20 = new Contract(
      address,
      [
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function decimals() view returns (uint8)",
      ],
      this.provider,
    ) as unknown as Erc20MetadataContract;

    const [symbol, name, decimals] = await Promise.all([
      erc20.symbol().catch(() => "UNKNOWN"),
      erc20.name().catch(() => "Unknown Token"),
      erc20.decimals().catch(() => 18),
    ]);

    return {
      symbol: String(symbol),
      name: String(name),
      decimals: Number(decimals),
    };
  }

  /**
   * Lists accepted tokens with live policy and inventory.
   * A token that fails metadata reads must not break the endpoint.
   */
  async listTokens(): Promise<TokenInfo[]> {
    const addresses = (await this.vault.acceptedTokens()) as string[];
    const native = await this.nativeTokenAddress();

    const tokens = await Promise.all(
      addresses.map(async (address) => {
        const isNative = address.toLowerCase() === native.toLowerCase();

        const [status, meta] = await Promise.all([
          this.vault.tokenStatus(address) as Promise<{
            cfg: {
              enabled: boolean;
              dripAmount: bigint;
              maxDispense: bigint;
              cooldown: bigint;
              dailyCap: bigint;
            };
            available: bigint;
          }>,
          this.readTokenMeta(address, isNative),
        ]);

        const drip = status.cfg.dripAmount;
        const inventory = status.available;

        return {
          address: isNative ? native : getAddress(address),
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          isNative,
          enabled: status.cfg.enabled,
          drip: formatUnits(drip, meta.decimals),
          cooldownSeconds: Number(status.cfg.cooldown),
          inventory: formatUnits(inventory, meta.decimals),
          lowInventory: inventory < drip,
        } satisfies TokenInfo;
      }),
    );

    // Stable ordering: native RUNE first, then alphabetically.
    return tokens.sort((a, b) => {
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  /**
   * Resolves a token selector (address or symbol) to token metadata.
   * @throws FaucetError when the token is unknown or not accepted.
   */
  async resolveToken(selector: string): Promise<TokenInfo> {
    const tokens = await this.listTokens();

    // `isAddress` is a `value is string` TYPE GUARD, not a plain boolean. Because
    // `selector` is already `string`, TypeScript narrows the else branch to `never`
    // — surviving even a stored-boolean alias. Reading the value back through a
    // `String(...)` call restores the real type without weakening anything: the
    // parameter is `string` by signature.
    if (isAddress(selector)) {
      const wanted = selector.toLowerCase();
      const found = tokens.find((t) => t.address.toLowerCase() === wanted);
      if (!found) {
        throw new FaucetError(
          400,
          "TOKEN_NOT_ACCEPTED",
          "That token is not accepted by this faucet.",
        );
      }
      return found;
    }

    const symbolSelector = String(selector).trim().toLowerCase();
    const bySymbol = tokens.find((t) => t.symbol.toLowerCase() === symbolSelector);
    if (!bySymbol) {
      throw new FaucetError(
        400,
        "TOKEN_NOT_ACCEPTED",
        `Unknown token symbol "${symbolSelector}".`,
      );
    }
    return bySymbol;
  }

  /** On-chain cooldown state for a wallet: seconds remaining, 0 when claimable. */
  async cooldownRemaining(tokenAddress: string, recipient: string): Promise<number> {
    const [, availableAt] = (await this.vault.claimableAt(tokenAddress, recipient)) as [
      boolean,
      bigint,
    ];

    const now = BigInt(Math.floor(Date.now() / 1000));
    return availableAt > now ? Number(availableAt - now) : 0;
  }

  /**
   * Executes a dispense.
   *
   * `amount` is always 0, which tells the contract to use its configured
   * `dripAmount`. The backend never chooses amounts: this deliberately shrinks
   * the blast radius of a compromised backend, since payout size is on-chain
   * policy and the backend cannot request more than `maxDispense`.
   */
  async dispense(token: TokenInfo, recipient: string): Promise<ClaimResult> {
    if (!isAddress(recipient)) {
      throw new FaucetError(400, "INVALID_ADDRESS", "Recipient is not a valid EVM address.");
    }

    const normalised = getAddress(recipient);

    return this.queue.run(async () => {
      try {
        const feeData = await this.provider.getFeeData();
        const priority = parseUnits(this.config.gas.priorityFeeGwei.toString(), "gwei");

        const overrides: Record<string, unknown> = {};
        if (feeData.maxFeePerGas !== null && feeData.maxFeePerGas !== undefined) {
          overrides.maxPriorityFeePerGas = priority;
          overrides.maxFeePerGas = feeData.maxFeePerGas + priority;
        } else if (feeData.gasPrice !== null && feeData.gasPrice !== undefined) {
          overrides.gasPrice = feeData.gasPrice + priority;
        }

        if (this.config.gas.gasLimit > 0) {
          overrides.gasLimit = this.config.gas.gasLimit;
        }

        // `amount = 0` => use the on-chain drip.
        const tx = await this.vault.dispense(token.address, normalised, 0n, overrides);
        const receipt = (await tx.wait()) as ContractTransactionReceipt | null;

        if (!receipt || receipt.status !== 1) {
          throw new FaucetError(502, "TX_FAILED", "The dispense transaction did not succeed.");
        }

        return {
          txHash: receipt.hash,
          token: token.address,
          amount: token.drip,
          recipient: normalised,
          blockNumber: receipt.blockNumber ?? null,
        } satisfies ClaimResult;
      } catch (error) {
        throw this.translateError(error);
      }
    });
  }

  /** Maps ethers / on-chain failures onto reportable API errors. */
  private translateError(error: unknown): FaucetError {
    if (error instanceof FaucetError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // On-chain custom errors appear inside the revert data; match on their names
    // so users get an actionable message instead of a hex blob.
    if (message.includes("CooldownActive")) {
      return new FaucetError(429, "COOLDOWN_ACTIVE", "This wallet has already claimed recently.");
    }
    if (message.includes("DailyCapExceeded")) {
      return new FaucetError(
        429,
        "DAILY_CAP_REACHED",
        "The faucet has reached its daily limit for this token.",
      );
    }
    if (message.includes("InsufficientInventory")) {
      return new FaucetError(
        503,
        "OUT_OF_INVENTORY",
        "The faucet vault is out of inventory for this token.",
      );
    }
    if (message.includes("TokenDisabled")) {
      return new FaucetError(503, "TOKEN_DISABLED", "This token is currently disabled.");
    }
    if (message.includes("TokenNotAccepted")) {
      return new FaucetError(
        400,
        "TOKEN_NOT_ACCEPTED",
        "That token is not accepted by this faucet.",
      );
    }
    if (message.includes("EnforcedPause")) {
      return new FaucetError(503, "PAUSED", "The faucet is paused.");
    }
    if (message.includes("AccessControlUnauthorizedAccount")) {
      return new FaucetError(
        500,
        "DISPENSER_UNAUTHORISED",
        "The backend dispenser is not authorised on the vault.",
      );
    }
    if (message.includes("nonce")) {
      return new FaucetError(503, "NONCE_CONFLICT", "Transaction nonce conflict; please retry.");
    }
    if (message.includes("insufficient funds")) {
      return new FaucetError(
        503,
        "DISPENSER_NO_GAS",
        "The faucet dispenser wallet has insufficient RUNE for gas.",
      );
    }

    return new FaucetError(502, "UPSTREAM_ERROR", `Dispense failed: ${message}`);
  }

  /** Current chain head, used by the health endpoint. */
  async blockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  destroy(): void {
    this.provider.destroy();
  }
}
