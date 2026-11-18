import type { AppConfig } from "../config";
import type { RateLimiter } from "../lib/rate-limiter";
import type { CaptchaService } from "./captcha";
import { FaucetError, VaultService, type ClaimResult, type TokenInfo } from "./vault";

/** Validated claim request, after schema parsing. */
export interface ClaimRequest {
  walletAddress: string;
  /** Token address or symbol. */
  tokenSymbol: string;
  captchaToken?: string;
  /** Client IP, used for the off-chain IP budget. */
  clientIp: string;
}

/** Successful claim response payload. */
export interface ClaimResponse extends ClaimResult {
  /** Seconds until this wallet may claim this token again. */
  retryAfterSeconds: number;
  network: { chainId: number; name: string };
}

/**
 * Orchestrates a claim through every gate, in a deliberate order.
 *
 * Ordering rationale — cheapest and most decisive checks first:
 *
 *   1. Token resolution   (rejects unknown input before any I/O cost)
 *   2. CAPTCHA            (rejects bots before touching Redis or the chain)
 *   3. On-chain pre-checks(disabled token, paused, cooldown, inventory)
 *   4. Redis wallet lock  (atomic, so concurrent duplicates cannot both pass)
 *   5. IP budget          (per-IP volume limit)
 *   6. Dispense           (the only step that spends gas)
 *
 * If step 6 fails after step 4 reserved the slot, the reservation is released so
 * a transient RPC error does not lock the user out for 24 hours.
 *
 * The vault independently re-checks cooldowns, caps and inventory, so a Redis
 * outage or flush cannot be used to drain it.
 */
export class ClaimService {
  constructor(
    private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly limiter: RateLimiter,
    private readonly captcha: CaptchaService,
  ) {}

  /** Tokens available on this faucet, for the UI. */
  async listTokens(): Promise<TokenInfo[]> {
    return this.vault.listTokens();
  }

  /** Executes a claim or throws a `FaucetError`. */
  async claim(request: ClaimRequest): Promise<ClaimResponse> {
    // --- 1. Resolve the token ---
    const token = await this.vault.resolveToken(request.tokenSymbol);

    if (!token.enabled) {
      throw new FaucetError(503, "TOKEN_DISABLED", `${token.symbol} is currently unavailable.`);
    }

    // --- 2. CAPTCHA ---
    try {
      await this.captcha.verify(request.captchaToken, request.clientIp);
    } catch (error) {
      throw new FaucetError(
        403,
        "CAPTCHA_FAILED",
        error instanceof Error ? error.message : "CAPTCHA verification failed.",
      );
    }

    // --- 3. On-chain pre-checks (cheap, no writes) ---
    if (await this.vault.isPaused()) {
      throw new FaucetError(503, "PAUSED", "The faucet is paused.");
    }

    if (token.lowInventory) {
      throw new FaucetError(
        503,
        "OUT_OF_INVENTORY",
        `The faucet has no ${token.symbol} left to dispense.`,
      );
    }

    const chainCooldown = await this.vault.cooldownRemaining(token.address, request.walletAddress);
    if (chainCooldown > 0) {
      throw new FaucetError(
        429,
        "COOLDOWN_ACTIVE",
        `This wallet has already claimed ${token.symbol}.`,
        { retryAfterSeconds: chainCooldown },
      );
    }

    // --- 4. Atomic wallet reservation ---
    const walletState = await this.limiter.checkWalletCooldown(
      request.walletAddress,
      this.config.cooldowns.claimSeconds,
    );

    if (!walletState.allowed) {
      throw new FaucetError(
        429,
        "COOLDOWN_ACTIVE",
        "This wallet has already claimed recently.",
        { retryAfterSeconds: walletState.retryAfterSeconds },
      );
    }

    // From here the wallet slot is held; any failure must release it.
    try {
      // --- 5. Per-IP budget ---
      const ipState = await this.limiter.consumeIpAllowance(
        request.clientIp,
        this.config.cooldowns.ipMaxClaims,
        this.config.cooldowns.ipWindowSeconds,
      );

      if (!ipState.allowed) {
        throw new FaucetError(
          429,
          "IP_LIMIT_REACHED",
          "Too many claims from this network. Try again later.",
          { retryAfterSeconds: ipState.resetSeconds },
        );
      }

      // --- 6. Dispense ---
      const result = await this.vault.dispense(token, request.walletAddress);

      await this.limiter.recordClaim(
        request.walletAddress,
        result.txHash,
        result.amount,
        token.symbol,
      );

      return {
        ...result,
        retryAfterSeconds: this.config.cooldowns.claimSeconds,
        network: {
          chainId: this.config.network.chainId,
          name: this.config.network.name,
        },
      };
    } catch (error) {
      // Release the wallet reservation so a failed claim stays retryable.
      await this.limiter.releaseWalletCooldown(request.walletAddress).catch(() => undefined);
      throw error;
    }
  }

  /** Cooldown state for the UI, combining chain and Redis views. */
  async status(
    walletAddress: string,
    tokenSelector: string,
  ): Promise<{
    token: TokenInfo;
    claimable: boolean;
    retryAfterSeconds: number;
  }> {
    const token = await this.vault.resolveToken(tokenSelector);

    const [chainCooldown, redisState] = await Promise.all([
      this.vault.cooldownRemaining(token.address, walletAddress),
      this.limiter.checkWalletCooldown(
        walletAddress,
        this.config.cooldowns.claimSeconds,
        false,
      ),
    ]);

    const retryAfterSeconds = Math.max(chainCooldown, redisState.retryAfterSeconds);

    return {
      token,
      claimable: retryAfterSeconds === 0 && token.enabled && !token.lowInventory,
      retryAfterSeconds,
    };
  }
}
