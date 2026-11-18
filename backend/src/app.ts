import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { loadConfig, type AppConfig } from "./config";
import { RateLimiter } from "./lib/rate-limiter";
import { CaptchaService } from "./services/captcha";
import { VaultService } from "./services/vault";
import { ClaimService } from "./services/claim";
import { createFaucetRouter, errorHandler } from "./routes/faucet";

/** Everything the app needs, constructed once at startup. */
export interface AppContext {
  app: Express;
  config: AppConfig;
  vault: VaultService;
  limiter: RateLimiter;
  shutdown: () => Promise<void>;
}

/**
 * Builds the Express application.
 *
 * Middleware order matters and is deliberate:
 *   1. `helmet`      — security headers first, so they apply to every response
 *   2. `cors`        — reject disallowed origins before doing any work
 *   3. `pino-http`   — request logging around the handlers
 *   4. body parsing  — bounded, so a huge body cannot exhaust memory
 *   5. global limiter— blunt per-IP flood protection ahead of the smart checks
 *   6. routes
 *   7. error handler — terminal
 */
export function buildApp(config: AppConfig = loadConfig()): AppContext {
  const app = express();

  // Behind nginx/Cloudflare the real client IP arrives in X-Forwarded-For.
  // Trusting the first hop makes `req.ip` correct for the IP budget. Set
  // TRUST_PROXY=0 when the API is directly internet-facing.
  const trustProxy = process.env.TRUST_PROXY ?? "1";
  app.set("trust proxy", trustProxy === "0" ? false : Number(trustProxy) || trustProxy);

  // The CAPTCHA iframe and wallet extensions occasionally need these relaxed.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin / non-browser requests have no Origin header.
        if (!origin) return callback(null, true);

        if (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      maxAge: 86_400,
    }),
  );

  app.use(
    pinoHttp({
      level: config.logLevel,
      // Never log the request body: it contains a wallet address and a CAPTCHA
      // token. Logging either is a privacy and replay concern.
      redact: ["req.headers.authorization", "req.headers.cookie"],
      autoLogging: {
        ignore: (req) => req.url === "/api/faucet/health",
      },
    }),
  );

  app.use(express.json({ limit: "16kb" }));

  // Coarse flood protection. The precise per-wallet/per-IP logic lives in
  // RateLimiter; this only stops a client hammering the endpoint.
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        error: { code: "RATE_LIMITED", message: "Too many requests. Slow down." },
      },
    }),
  );

  const limiter = new RateLimiter(config.redisUrl, config.network.key);
  const vault = new VaultService(config);
  const captcha = new CaptchaService(config.captcha);
  const claimService = new ClaimService(config, vault, limiter, captcha);

  app.use("/api/faucet", createFaucetRouter(config, claimService, vault, limiter));

  app.get("/", (_req, res) => {
    res.json({
      name: "Hoodium Faucet API",
      network: config.network.name,
      chainId: config.network.chainId,
      endpoints: [
        "GET  /api/faucet/tokens",
        "GET  /api/faucet/status?walletAddress=&token=",
        "POST /api/faucet/claim",
        "GET  /api/faucet/health",
      ],
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  // Must be registered last.
  app.use(errorHandler());

  return {
    app,
    config,
    vault,
    limiter,
    shutdown: async () => {
      await limiter.close().catch(() => undefined);
      vault.destroy();
    },
  };
}
