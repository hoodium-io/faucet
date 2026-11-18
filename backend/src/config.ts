import { z } from "zod";

/**
 * Environment schema.
 *
 * Everything the process needs is validated at startup so a misconfigured
 * deployment fails immediately and loudly, instead of at the first claim.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // --- Hoodium chain ---
  /** Network key: selects chain ID + display metadata. */
  HOODIUM_NETWORK: z.enum(["devnet", "testnet", "mainnet"]).default("devnet"),
  /** EVM JSON-RPC endpoint. */
  HOODIUM_RPC_URL: z.string().url().default("http://127.0.0.1:8545"),

  // --- Vault ---
  /** Deployed FaucetVault address. */
  FAUCET_VAULT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address"),
  /** Hot key holding DISPENSER_ROLE. Never a custody key. */
  FAUCET_DISPENSER_PRIVATE_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key"),

  // --- Redis ---
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  // --- Anti-abuse ---
  /** Per-wallet cooldown in seconds (mirrors the on-chain default). */
  CLAIM_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(86_400),
  /** Max claims per IP per window. */
  IP_MAX_CLAIMS: z.coerce.number().int().positive().default(5),
  /** IP rate-limit window in seconds. */
  IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(86_400),

  // --- CAPTCHA (optional; ENABLED only when a secret is present) ---
  CAPTCHA_PROVIDER: z.enum(["none", "turnstile", "recaptcha"]).default("none"),
  CAPTCHA_SECRET_KEY: z.string().optional(),
  /** Public site key. Safe to expose to browsers; required by the frontend. */
  CAPTCHA_SITE_KEY: z.string().optional(),

  // --- Gas ---
  /** Priority fee in gwei added on top of the base fee. */
  GAS_PRIORITY_FEE_GWEI: z.coerce.number().nonnegative().default(1),
  /** Optional hard gas limit per dispense; 0 means "estimate". */
  GAS_LIMIT: z.coerce.number().int().nonnegative().default(0),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Chain metadata for the three Hoodium networks.
 *
 * Verified against `hoodium/docs/networks.md` and `hoodium/utils/utils.go`:
 * the Cosmos chain-id is `rune_<evmChainId>` with a `-1` revision suffix, and
 * the EVM chain ID is the bare number. RUNE is the 18-decimal gas token.
 */
export interface NetworkMeta {
  key: "devnet" | "testnet" | "mainnet";
  chainId: number;
  cosmosChainId: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Block explorer, if one exists. Hoodium has none yet. */
  explorerUrl: string | null;
}

export const NETWORKS: Record<NetworkMeta["key"], NetworkMeta> = {
  devnet: {
    key: "devnet",
    chainId: 6592,
    cosmosChainId: "rune_6592-1",
    name: "Hoodium Devnet",
    nativeCurrency: { name: "RUNE", symbol: "RUNE", decimals: 18 },
    explorerUrl: null,
  },
  testnet: {
    key: "testnet",
    chainId: 6591,
    cosmosChainId: "rune_6591-1",
    name: "Hoodium Testnet",
    nativeCurrency: { name: "RUNE", symbol: "RUNE", decimals: 18 },
    explorerUrl: null,
  },
  mainnet: {
    key: "mainnet",
    chainId: 6590,
    cosmosChainId: "rune_6590-1",
    name: "Hoodium Mainnet",
    nativeCurrency: { name: "RUNE", symbol: "RUNE", decimals: 18 },
    explorerUrl: null,
  },
};

/** Fully-resolved, validated application config. */
export interface AppConfig {
  env: Env["NODE_ENV"];
  port: number;
  logLevel: Env["LOG_LEVEL"];
  corsOrigins: string[];
  network: NetworkMeta;
  rpcUrl: string;
  vaultAddress: string;
  dispenserPrivateKey: string;
  redisUrl: string;
  cooldowns: { claimSeconds: number; ipMaxClaims: number; ipWindowSeconds: number };
  captcha: { provider: Env["CAPTCHA_PROVIDER"]; secretKey: string | null; siteKey: string | null };
  gas: { priorityFeeGwei: number; gasLimit: number };
}

/**
 * Parses and validates process env.
 * @throws when a required value is missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const e = parsed.data;

  if (e.CAPTCHA_PROVIDER !== "none" && !e.CAPTCHA_SECRET_KEY) {
    throw new Error(
      `CAPTCHA_PROVIDER=${e.CAPTCHA_PROVIDER} requires CAPTCHA_SECRET_KEY to be set.`,
    );
  }

  // The site key is public, but the widget cannot render without it. Failing at
  // startup is far better than a silently broken claim button.
  if (e.CAPTCHA_PROVIDER !== "none" && !e.CAPTCHA_SITE_KEY) {
    throw new Error(
      `CAPTCHA_PROVIDER=${e.CAPTCHA_PROVIDER} requires CAPTCHA_SITE_KEY to be set (the public key).`,
    );
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    network: NETWORKS[e.HOODIUM_NETWORK],
    rpcUrl: e.HOODIUM_RPC_URL,
    vaultAddress: e.FAUCET_VAULT_ADDRESS,
    dispenserPrivateKey: e.FAUCET_DISPENSER_PRIVATE_KEY,
    redisUrl: e.REDIS_URL,
    cooldowns: {
      claimSeconds: e.CLAIM_COOLDOWN_SECONDS,
      ipMaxClaims: e.IP_MAX_CLAIMS,
      ipWindowSeconds: e.IP_WINDOW_SECONDS,
    },
    captcha: {
      provider: e.CAPTCHA_PROVIDER,
      secretKey: e.CAPTCHA_SECRET_KEY ?? null,
      siteKey: e.CAPTCHA_SITE_KEY ?? null,
    },
    gas: {
      priorityFeeGwei: e.GAS_PRIORITY_FEE_GWEI,
      gasLimit: e.GAS_LIMIT,
    },
  };
}
