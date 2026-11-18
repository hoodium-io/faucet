/**
 * Shared API types.
 *
 * These mirror the backend's response shapes. They are declared by hand rather
 * than imported because the frontend is a separate package with its own build;
 * a shared package would be over-engineering for four endpoints.
 */

/** One accepted token, as reported by `GET /api/faucet/tokens`. */
export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isNative: boolean;
  enabled: boolean;
  /** Drip per claim, in whole units, decimal string. */
  drip: string;
  cooldownSeconds: number;
  /** Vault inventory, in whole units. */
  inventory: string;
  lowInventory: boolean;
}

/** Network metadata returned alongside the token list. */
export interface NetworkInfo {
  /** Devnet and testnet only — a faucet never serves mainnet. */
  key: "devnet" | "testnet";
  chainId: number;
  cosmosChainId: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl: string | null;
  rpcUrl: string;
}

/** Payload of `GET /api/faucet/tokens`. */
export interface TokensResponse {
  network: NetworkInfo;
  vaultAddress: string;
  captcha: {
    enabled: boolean;
    provider: "none" | "turnstile" | "recaptcha";
    /** Public site key, needed to render the widget. */
    siteKey: string | null;
  };
  cooldowns: { claimSeconds: number; ipMaxClaims: number; ipWindowSeconds: number };
  tokens: TokenInfo[];
}

/** Successful claim, from `POST /api/faucet/claim`. */
export interface ClaimRecord {
  txHash: string;
  token: string;
  amount: string;
  recipient: string;
  blockNumber: number | null;
  retryAfterSeconds: number;
  network: { chainId: number; name: string };
}

/** Cooldown state from `GET /api/faucet/status`. */
export interface StatusResponse {
  token: TokenInfo;
  claimable: boolean;
  retryAfterSeconds: number;
}

/** Error body shape returned by the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
    issues?: Array<{ field: string; message: string }>;
  };
}
