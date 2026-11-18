import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, fetchStatus, postClaim } from "@/lib/api";
import { describeCooldown, formatAmount, formatCountdown, isEvmAddress } from "@/lib/format";
import type { ClaimRecord, TokenInfo } from "@/lib/types";
import { TokenSelect } from "./TokenSelect";
import { CaptchaWidget } from "./CaptchaWidget";

/** CAPTCHA configuration as delivered by the API. */
export interface CaptchaConfig {
  enabled: boolean;
  provider: "none" | "turnstile" | "recaptcha";
  siteKey: string | null;
}

interface ClaimCardProps {
  tokens: TokenInfo[];
  selected: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  captcha: CaptchaConfig;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; claim: ClaimRecord }
  | { kind: "error"; message: string; code: string };

/**
 * The core "Get Test Tokens" card.
 *
 * Owns the address input, the submit flow and the per-wallet cooldown countdown.
 * Nothing here signs anything: the claim is a plain API call, because the vault is
 * dispensed by the backend's authorised account. That is why the user never needs
 * to connect a wallet.
 */
export function ClaimCard({ tokens, selected, onSelect, captcha }: ClaimCardProps) {
  const [address, setAddress] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [touched, setTouched] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  // Bumping this remounts the CAPTCHA widget, which is how a spent token gets
  // replaced. Without it, clearing `captchaToken` after a successful claim would
  // leave the widget showing "solved" while the app holds no token — and the
  // button would stay disabled.
  const [captchaEpoch, setCaptchaEpoch] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const trimmed = address.trim();
  const addressValid = isEvmAddress(trimmed);

  const isSubmitting = state.kind === "submitting";
  const inCooldown = secondsLeft > 0;
  const tokenUsable = selected !== null && selected.enabled && !selected.lowInventory;

  // When CAPTCHA is on, a solved token is mandatory — the backend answers 403
  // otherwise. Checking it here turns a guaranteed round-trip failure into a
  // disabled button.
  const captchaSatisfied = !captcha.enabled || captchaToken.length > 0;

  const canSubmit = addressValid && tokenUsable && !isSubmitting && !inCooldown && captchaSatisfied;


  // --- Cooldown ticker -----------------------------------------------------
  // Driven locally from a target timestamp so the countdown stays smooth and the
  // API is not polled every second.
  useEffect(() => {
    if (cooldownEndsAt === null) {
      setSecondsLeft(0);
      return;
    }

    const tick = () => {
      const remaining = Math.ceil((cooldownEndsAt - Date.now()) / 1000);
      if (remaining <= 0) {
        setSecondsLeft(0);
        setCooldownEndsAt(null);
      } else {
        setSecondsLeft(remaining);
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownEndsAt]);

  // --- Probe this wallet's cooldown when address + token change ---
  useEffect(() => {
    if (!addressValid || !selected) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetchStatus(trimmed, selected.address, controller.signal)
      .then((status) => {
        if (status.retryAfterSeconds > 0) {
          setCooldownEndsAt(Date.now() + status.retryAfterSeconds * 1000);
        }
      })
      .catch(() => {
        // A failed status probe must not block the user: the claim endpoint
        // re-checks every limit server-side.
      });

    return () => controller.abort();
  }, [trimmed, addressValid, selected]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setTouched(true);

      if (!canSubmit || !selected) return;

      setState({ kind: "submitting" });

      try {
        const claim = await postClaim({
          walletAddress: trimmed,
          tokenSymbol: selected.address,
          captchaToken: captcha.enabled ? captchaToken : undefined,
        });

        setState({ kind: "success", claim });

        // CAPTCHA tokens are single-use: clear it and remount the widget so a
        // second claim needs a fresh solve rather than replaying a spent token.
        if (captcha.enabled) {
          setCaptchaToken("");
          setCaptchaEpoch((n) => n + 1);
        }

        if (claim.retryAfterSeconds > 0) {
          setCooldownEndsAt(Date.now() + claim.retryAfterSeconds * 1000);
        }
      } catch (error) {
        if (error instanceof ApiError) {
          setState({ kind: "error", message: error.message, code: error.code });

          if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
            setCooldownEndsAt(Date.now() + error.retryAfterSeconds * 1000);
          }
        } else {
          setState({
            kind: "error",
            message: "Network error. Please check your connection and try again.",
            code: "NETWORK_ERROR",
          });
        }
      }
    },
    [canSubmit, selected, trimmed, captcha.enabled, captchaToken],
  );

  const buttonLabel = useMemo(() => {
    if (isSubmitting) return "Sending…";
    if (inCooldown) return `Claimable in ${formatCountdown(secondsLeft)}`;
    if (!selected) return "Select a token";
    return `Send ${formatAmount(selected.drip)} ${selected.symbol}`;
  }, [isSubmitting, inCooldown, secondsLeft, selected]);

  const showAddressError = touched && trimmed.length > 0 && !addressValid;

  return (
    <div className="faucet-card p-6 sm:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Get Test Tokens
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {selected
            ? `Every ${describeCooldown(selected.cooldownSeconds)}, ${selected.symbol} can be claimed once per address.`
            : "Every 24 hours, Devnet test tokens can be claimed once per address."}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="faucet-label mb-2 block" htmlFor="token-select">
            Token
          </label>
          <div id="token-select">
            <TokenSelect
              tokens={tokens}
              selected={selected}
              onSelect={onSelect}
              disabled={isSubmitting}
            />
          </div>
        </div>

        <div>
          <label className="faucet-label mb-2 block" htmlFor="wallet-address">
            Wallet address
          </label>
          <input
            id="wallet-address"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              if (state.kind !== "idle") setState({ kind: "idle" });
            }}
            onBlur={() => setTouched(true)}
            placeholder="Input your wallet address (0x...)"
            aria-invalid={showAddressError}
            aria-describedby={showAddressError ? "address-error" : undefined}
            className="faucet-input mono"
          />
          {showAddressError && (
            <p id="address-error" className="mt-1.5 text-xs text-red-400">
              Enter a valid 42-character address starting with 0x.
            </p>
          )}
        </div>

        {captcha.enabled && captcha.provider !== "none" && captcha.siteKey ? (
          <div>
            <span className="faucet-label mb-2 block">Verification</span>
            <CaptchaWidget
              key={captchaEpoch}
              provider={captcha.provider}
              siteKey={captcha.siteKey}
              onToken={setCaptchaToken}
            />
            {!captchaSatisfied && (
              <p className="mt-1.5 text-xs text-slate-500">
                Complete the check above to enable the claim.
              </p>
            )}
          </div>
        ) : captcha.enabled ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            CAPTCHA is enabled on the server but no site key was provided, so claims
            cannot be submitted. Set <span className="mono">CAPTCHA_SITE_KEY</span> on the backend.
          </p>
        ) : null}

        <button type="submit" disabled={!canSubmit} className="faucet-button">
          {isSubmitting && (
            <svg
              className="h-4 w-4 animate-spin-slow"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                className="opacity-25"
              />
              <path
                d="M12 2a10 10 0 0110 10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          )}
          {buttonLabel}
        </button>
      </form>

      <ClaimFeedback state={state} />
    </div>
  );
}

/** Renders the success / error panel below the form. */
function ClaimFeedback({ state }: { state: SubmitState }) {
  if (state.kind === "idle" || state.kind === "submitting") return null;

  if (state.kind === "success") {
    return (
      <div
        role="status"
        className="mt-4 animate-fade-in rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"
      >
        <p className="text-sm font-medium text-emerald-300">Tokens sent</p>
        <p className="mt-1 text-xs text-emerald-200/70">
          {formatAmount(state.claim.amount)} sent to{" "}
          <span className="mono">{state.claim.recipient}</span>
        </p>
        <p className="mt-2 text-xs text-slate-400">
          Transaction:{" "}
          <span className="mono break-all text-slate-300">{state.claim.txHash}</span>
        </p>
        {state.claim.blockNumber !== null && (
          <p className="mt-1 text-xs text-slate-500">Included in block {state.claim.blockNumber}</p>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="mt-4 animate-fade-in rounded-xl border border-red-500/30 bg-red-500/10 p-4"
    >
      <p className="text-sm font-medium text-red-300">{state.message}</p>
      <p className="mono mt-1 text-[11px] uppercase tracking-wide text-red-400/60">{state.code}</p>
    </div>
  );
}
