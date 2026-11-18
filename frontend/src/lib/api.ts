import type {
  ApiErrorBody,
  ClaimRecord,
  StatusResponse,
  TokensResponse,
} from "./types";

/** Thrown for any non-2xx API response, carrying the parsed error code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly issues?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Base URL for the API.
 *
 * Defaults to a relative `/api` path: in development Vite proxies it to the
 * backend, and in production nginx serves the SPA and proxies `/api` to the API
 * container. Both cases keep the browser on a single origin, so no CORS
 * configuration is needed for the common deployment.
 */
const BASE = import.meta.env.VITE_API_BASE_URL || "/api";

/** Parses a response, converting API errors into `ApiError`. */
async function parse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }

  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error (proxy timeout, HTML error page) — fall through.
  }

  throw new ApiError(
    response.status,
    body?.error?.code ?? "UNKNOWN_ERROR",
    body?.error?.message ?? `Request failed with status ${response.status}.`,
    body?.error?.retryAfterSeconds,
    body?.error?.issues,
  );
}

/** Fetches accepted tokens, network metadata and cooldown policy. */
export async function fetchTokens(signal?: AbortSignal): Promise<TokensResponse> {
  const response = await fetch(`${BASE}/faucet/tokens`, { signal });
  return parse<TokensResponse>(response);
}

/** Submits a claim. */
export async function postClaim(
  body: { walletAddress: string; tokenSymbol: string; captchaToken?: string },
  signal?: AbortSignal,
): Promise<ClaimRecord> {
  const response = await fetch(`${BASE}/faucet/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const parsed = await parse<{ ok: boolean; claim: ClaimRecord }>(response);
  return parsed.claim;
}

/** Reads a wallet's cooldown state for one token. */
export async function fetchStatus(
  walletAddress: string,
  token: string,
  signal?: AbortSignal,
): Promise<StatusResponse> {
  const params = new URLSearchParams({ walletAddress, token });
  const response = await fetch(`${BASE}/faucet/status?${params.toString()}`, { signal });
  return parse<StatusResponse>(response);
}
