import type { AppConfig } from "../config";

/** Thrown when CAPTCHA verification fails. */
export class CaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaError";
  }
}

interface VerifyOutcome {
  ok: boolean;
  /** Provider error codes, for logging only. Never shown verbatim to clients. */
  codes: string[];
}

/**
 * CAPTCHA verification.
 *
 * Supports Cloudflare Turnstile and Google reCAPTCHA v2/v3, chosen because both
 * are drop-in script tags with a server-side `siteverify` endpoint. When
 * `provider` is `none`, verification is skipped — acceptable for a local devnet,
 * **never** for a public testnet.
 *
 * Design notes:
 * - The secret stays server-side; the frontend only ever sees the site key.
 * - Failure is closed: any network error or unexpected payload rejects the claim.
 * - Timeouts are explicit so a slow CAPTCHA provider cannot stall the faucet.
 */
export class CaptchaService {
  private static readonly TIMEOUT_MS = 5_000;

  constructor(private readonly config: AppConfig["captcha"]) {}

  /** Whether CAPTCHA is actually enforced. */
  get enabled(): boolean {
    return this.config.provider !== "none";
  }

  /**
   * Verifies a client-supplied CAPTCHA token.
   * @param token    Token produced by the client widget.
   * @param remoteIp Optional client IP, improves provider-side scoring.
   * @throws CaptchaError when verification fails or is misconfigured.
   */
  async verify(token: string | undefined, remoteIp?: string): Promise<void> {
    if (!this.enabled) return;

    if (!token || token.trim().length === 0) {
      throw new CaptchaError("Missing CAPTCHA token.");
    }

    if (!this.config.secretKey) {
      throw new CaptchaError("CAPTCHA is enabled but no secret key is configured.");
    }

    const endpoint =
      this.config.provider === "turnstile"
        ? "https://challenges.cloudflare.com/turnstile/v0/siteverify"
        : "https://www.google.com/recaptcha/api/siteverify";

    const form = new URLSearchParams({
      secret: this.config.secretKey,
      response: token,
    });
    if (remoteIp) form.set("remoteip", remoteIp);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CaptchaService.TIMEOUT_MS);

    let outcome: VerifyOutcome;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new CaptchaError(`CAPTCHA provider returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as {
        success?: boolean;
        "error-codes"?: string[];
      };

      outcome = {
        ok: payload.success === true,
        codes: payload["error-codes"] ?? [],
      };
    } catch (error) {
      if (error instanceof CaptchaError) throw error;
      // Fail closed: a provider outage must not silently disable the CAPTCHA.
      throw new CaptchaError(
        `CAPTCHA verification could not be completed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!outcome.ok) {
      throw new CaptchaError(
        `CAPTCHA rejected (${outcome.codes.length > 0 ? outcome.codes.join(",") : "no reason given"}).`,
      );
    }
  }
}
