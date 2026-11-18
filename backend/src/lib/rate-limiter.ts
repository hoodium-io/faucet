import Redis from "ioredis";

/** Result of a cooldown check. */
export interface CooldownState {
  /** Whether the claim is allowed right now. */
  allowed: boolean;
  /** Seconds remaining until the claim becomes possible (0 when allowed). */
  retryAfterSeconds: number;
}

/** Outcome of consuming one IP allowance. */
export interface IpAllowance {
  allowed: boolean;
  /** Remaining claims for this IP in the current window. */
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

/**
 * Redis-backed anti-abuse store.
 *
 * This is the **off-chain** half of the two-layer enforcement model. It does
 * things the contract cannot see (client IP) and does them cheaply (no gas).
 * It is never trusted as the only defence: the vault enforces its own cooldowns
 * and caps, so a Redis flush cannot be used to drain inventory.
 *
 * Key layout:
 *   faucet:cooldown:wallet:<network>:<address>   -> "1" with TTL
 *   faucet:cooldown:ip:<network>:<ip>            -> counter with TTL
 *   faucet:nonce                                 -> reserved for future use
 */
export class RateLimiter {
  private readonly redis: Redis;
  private readonly networkKey: string;

  constructor(redisUrl: string, networkKey: string) {
    this.redis = new Redis(redisUrl, {
      // Fail fast rather than hanging a request when Redis is unavailable.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    this.networkKey = networkKey;
  }

  /** Exposed for health checks. */
  get client(): Redis {
    return this.redis;
  }

  /**
   * Checks (and, when `consume` is true, reserves) a wallet's claim slot.
   *
   * Uses `SET NX` so the reservation is atomic: two concurrent requests for the
   * same wallet cannot both pass.
   *
   * @param address Lowercased EVM address.
   * @param cooldownSeconds Cooldown duration.
   * @param consume When false, only reads the current state.
   */
  async checkWalletCooldown(
    address: string,
    cooldownSeconds: number,
    consume = true,
  ): Promise<CooldownState> {
    if (cooldownSeconds <= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const key = `faucet:cooldown:wallet:${this.networkKey}:${address.toLowerCase()}`;

    if (!consume) {
      const ttl = await this.redis.ttl(key);
      return ttl > 0
        ? { allowed: false, retryAfterSeconds: ttl }
        : { allowed: true, retryAfterSeconds: 0 };
    }

    const result = await this.redis.set(key, "1", "EX", cooldownSeconds, "NX");

    if (result === "OK") {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const ttl = await this.redis.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : cooldownSeconds };
  }

  /**
   * Consumes one claim from an IP's window budget.
   *
   * Uses `INCR` + `EXPIRE` in a pipeline. The first increment of a window sets
   * the expiry, so the window slides from the first claim.
   */
  async consumeIpAllowance(
    ip: string,
    maxClaims: number,
    windowSeconds: number,
  ): Promise<IpAllowance> {
    if (maxClaims <= 0) {
      return { allowed: true, remaining: 0, resetSeconds: 0 };
    }

    const key = `faucet:cooldown:ip:${this.networkKey}:${ip}`;

    const results = await this.redis.multi().incr(key).ttl(key).exec();

    if (!results || results.length < 2) {
      throw new Error("Redis transaction returned an unexpected result.");
    }

    // `exec()` returns `[error, result]` tuples. Element access is checked
    // explicitly because `noUncheckedIndexedAccess` makes each index possibly
    // undefined.
    const incrEntry = results[0];
    const ttlEntry = results[1];

    if (!incrEntry || !ttlEntry) {
      throw new Error("Redis transaction returned incomplete results.");
    }

    const [incrErr, countRaw] = incrEntry;
    const [ttlErr, ttlRaw] = ttlEntry;

    if (incrErr) throw incrErr;
    if (ttlErr) throw ttlErr;

    const count = Number(countRaw);
    let ttl = Number(ttlRaw);

    // A fresh key has TTL -1; set the window expiry exactly once.
    if (ttl < 0) {
      await this.redis.expire(key, windowSeconds);
      ttl = windowSeconds;
    }

    if (count > maxClaims) {
      return { allowed: false, remaining: 0, resetSeconds: ttl };
    }

    return { allowed: true, remaining: Math.max(0, maxClaims - count), resetSeconds: ttl };
  }

  /**
   * Releases a wallet reservation. Called when a claim fails *after* the
   * reservation was taken, so a transient RPC error does not lock the user out
   * for the full cooldown.
   */
  async releaseWalletCooldown(address: string): Promise<void> {
    const key = `faucet:cooldown:wallet:${this.networkKey}:${address.toLowerCase()}`;
    await this.redis.del(key);
  }

  /** Records a successful claim reference for auditability. */
  async recordClaim(address: string, txHash: string, amount: string, token: string): Promise<void> {
    const key = `faucet:claims:${this.networkKey}`;
    const entry = JSON.stringify({
      address: address.toLowerCase(),
      txHash,
      amount,
      token,
      at: new Date().toISOString(),
    });

    await this.redis
      .multi()
      .lpush(key, entry)
      // Bound the audit list so it cannot grow without limit.
      .ltrim(key, 0, 9_999)
      .exec();
  }

  /** Number of claims recorded for this network (bounded by the trim above). */
  async recentClaimCount(): Promise<number> {
    return this.redis.llen(`faucet:claims:${this.networkKey}`);
  }

  async ping(): Promise<boolean> {
    const res = await this.redis.ping();
    return res === "PONG";
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
