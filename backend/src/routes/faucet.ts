import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { AppConfig } from "../config";
import { ClaimService } from "../services/claim";
import { FaucetError, VaultService } from "../services/vault";
import type { RateLimiter } from "../lib/rate-limiter";

/**
 * Request schema for `POST /api/faucet/claim`.
 *
 * `tokenSymbol` accepts a symbol ("RUNE") or a 0x address, so the UI can send
 * whichever it holds. Validation happens here, before any chain call.
 */
const ClaimSchema = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "walletAddress must be a 0x-prefixed 20-byte address"),
  tokenSymbol: z.string().min(1).max(64),
  captchaToken: z.string().max(4096).optional(),
});

/** Query schema for `GET /api/faucet/status`. */
const StatusQuerySchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  token: z.string().min(1).max(64),
});

/** Extracts the client IP, honouring a reverse proxy. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Wraps an async handler so rejected promises reach the error middleware. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Builds the faucet API router. */
export function createFaucetRouter(
  config: AppConfig,
  claimService: ClaimService,
  vault: VaultService,
  limiter: RateLimiter,
): Router {
  const router = Router();

  /**
   * GET /api/faucet/tokens
   * Lists accepted tokens with live policy and inventory.
   */
  router.get(
    "/tokens",
    asyncHandler(async (_req, res) => {
      const tokens = await claimService.listTokens();

      res.json({
        network: {
          key: config.network.key,
          chainId: config.network.chainId,
          cosmosChainId: config.network.cosmosChainId,
          name: config.network.name,
          nativeCurrency: config.network.nativeCurrency,
          explorerUrl: config.network.explorerUrl,
          rpcUrl: config.rpcUrl,
        },
        vaultAddress: config.vaultAddress,
        // The dispenser address is public information (it is an on-chain role
        // holder) and the admin console needs it to prefill "fund the dispenser".
        // It is an *address*, never the key.
        dispenserAddress: vault.dispenserAddress,
        captcha: {
          enabled: config.captcha.provider !== "none",
          provider: config.captcha.provider,
          // The site key is public by design; the secret never leaves the server.
          siteKey: config.captcha.siteKey,
        },
        cooldowns: config.cooldowns,
        tokens,
      });
    }),
  );

  /**
   * POST /api/faucet/claim
   * Body: { walletAddress, tokenSymbol, captchaToken? }
   */
  router.post(
    "/claim",
    asyncHandler(async (req, res) => {
      const parsed = ClaimSchema.safeParse(req.body);

      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        }));

        res.status(400).json({
          error: { code: "VALIDATION_FAILED", message: "Invalid request body.", issues },
        });
        return;
      }

      const result = await claimService.claim({
        walletAddress: parsed.data.walletAddress,
        tokenSymbol: parsed.data.tokenSymbol,
        captchaToken: parsed.data.captchaToken,
        clientIp: clientIp(req),
      });

      res.status(200).json({ ok: true, claim: result });
    }),
  );

  /**
   * GET /api/faucet/status?walletAddress=0x..&token=RUNE
   * Cooldown state for the UI countdown.
   */
  router.get(
    "/status",
    asyncHandler(async (req, res) => {
      const parsed = StatusQuerySchema.safeParse(req.query);

      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "VALIDATION_FAILED",
            message: "walletAddress and token are required and must be well-formed.",
          },
        });
        return;
      }

      const status = await claimService.status(parsed.data.walletAddress, parsed.data.token);
      res.json({ ok: true, ...status });
    }),
  );

  /**
   * GET /api/faucet/health
   * Reports the dependencies an operator cares about: RPC, chain identity,
   * dispenser authorisation, pause state, gas balance and Redis.
   */
  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};

      try {
        const chainId = await vault.assertCorrectChain();
        checks.chain = { ok: true, detail: `chain ID ${chainId}` };
      } catch (error) {
        checks.chain = { ok: false, detail: error instanceof Error ? error.message : "unknown" };
      }

      try {
        const block = await vault.blockNumber();
        checks.rpc = { ok: true, detail: `block ${block}` };
      } catch (error) {
        checks.rpc = { ok: false, detail: error instanceof Error ? error.message : "unknown" };
      }

      try {
        const authorised = await vault.assertDispenserAuthorised();
        checks.dispenser = {
          ok: authorised,
          detail: authorised ? "DISPENSER_ROLE held" : "DISPENSER_ROLE missing",
        };
      } catch (error) {
        checks.dispenser = {
          ok: false,
          detail: error instanceof Error ? error.message : "unknown",
        };
      }

      try {
        const paused = await vault.isPaused();
        checks.paused = { ok: !paused, detail: paused ? "paused" : "active" };
      } catch {
        checks.paused = { ok: false, detail: "unreadable" };
      }

      try {
        const gas = await vault.dispenserGasBalance();
        // Warn below 1 RUNE, which is roughly 19 simple transfers.
        checks.dispenserGas = {
          ok: gas > 1_000_000_000_000_000_000n,
          detail: `${gas.toString()} wei`,
        };
      } catch {
        checks.dispenserGas = { ok: false, detail: "unreadable" };
      }

      try {
        checks.redis = { ok: await limiter.ping() };
      } catch (error) {
        checks.redis = { ok: false, detail: error instanceof Error ? error.message : "unknown" };
      }

      const ok = Object.values(checks).every((c) => c.ok);
      res.status(ok ? 200 : 503).json({ ok, checks });
    }),
  );

  return router;
}

/**
 * Terminal error middleware.
 *
 * Translates `FaucetError` into its declared status; anything else becomes a
 * generic 500 so internal details never leak. `retryAfterSeconds` in the details
 * is mirrored into the `Retry-After` header for standard HTTP clients.
 */
export function errorHandler() {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof FaucetError) {
      const retry = err.details?.retryAfterSeconds;

      if (typeof retry === "number" && retry > 0) {
        res.setHeader("Retry-After", String(retry));
      }

      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...err.details },
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
      // Surfaced only outside production.
      detail: process.env.NODE_ENV === "production" ? undefined : message,
    });
  };
}
