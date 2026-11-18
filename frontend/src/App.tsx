import { useEffect, useState } from "react";
import { fetchTokens } from "@/lib/api";
import type { NetworkInfo, TokenInfo } from "@/lib/types";
import { Header } from "@/components/Header";
import { ClaimCard, type CaptchaConfig } from "@/components/ClaimCard";
import { Channels } from "@/components/Channels";
import { Faq } from "@/components/Faq";

/** Default before the API responds: CAPTCHA off, so no widget is mounted. */
const DEFAULT_CAPTCHA: CaptchaConfig = { enabled: false, provider: "none", siteKey: null };

/**
 * Application shell.
 *
 * Fetches the token/network config once on mount, selects a sensible default
 * token, and renders the three sections. All state that matters to more than one
 * component lives here; the child components stay presentational plus local
 * interaction state.
 */
export default function App() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [vaultAddress, setVaultAddress] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [selected, setSelected] = useState<TokenInfo | null>(null);
  const [captcha, setCaptcha] = useState<CaptchaConfig>(DEFAULT_CAPTCHA);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    fetchTokens(controller.signal)
      .then((data) => {
        setNetwork(data.network);
        setVaultAddress(data.vaultAddress);
        setTokens(data.tokens);
        setCaptcha(data.captcha);

        // Prefer native RUNE — it is the gas token, so it is what a new user
        // needs first. Fall back to the first usable token.
        const preferred =
          data.tokens.find((t) => t.isNative && t.enabled && !t.lowInventory) ??
          data.tokens.find((t) => t.enabled && !t.lowInventory) ??
          data.tokens[0] ??
          null;

        setSelected(preferred);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(
          error instanceof Error ? error.message : "Could not load faucet configuration.",
        );
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  return (
    <div className="min-h-screen bg-ink-950">
      <Header network={network} vaultAddress={vaultAddress} />

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mx-auto max-w-xl">
          {loadError ? (
            <div className="faucet-card p-6 sm:p-8" role="alert">
              <h1 className="text-lg font-semibold text-red-300">Faucet unavailable</h1>
              <p className="mt-2 text-sm text-slate-400">{loadError}</p>
              <p className="mt-4 text-xs text-slate-500">
                The API may be starting up or unreachable. Check{" "}
                <span className="mono">/api/faucet/health</span> on the backend.
              </p>
            </div>
          ) : loading ? (
            <Skeleton />
          ) : (
            <ClaimCard
              tokens={tokens}
              selected={selected}
              onSelect={setSelected}
              captcha={captcha}
            />
          )}

          {!loadError && !loading && (
            <>
              <Channels />
              <Faq />
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-ink-800 py-6">
        <div className="mx-auto max-w-5xl px-4 text-center text-xs text-slate-600 sm:px-6">
          Hoodium Devnet tokens have no financial value and are for development only.
        </div>
      </footer>
    </div>
  );
}

/** Loading placeholder that reserves the card's height to avoid layout shift. */
function Skeleton() {
  return (
    <div className="faucet-card animate-pulse p-6 sm:p-8" aria-busy="true" aria-live="polite">
      <div className="h-8 w-56 rounded bg-ink-800" />
      <div className="mt-3 h-4 w-72 rounded bg-ink-850" />
      <div className="mt-6 h-[62px] rounded-xl bg-ink-850" />
      <div className="mt-4 h-[62px] rounded-xl bg-ink-850" />
      <div className="mt-4 h-[52px] rounded-xl bg-ink-800" />
      <span className="sr-only">Loading faucet configuration…</span>
    </div>
  );
}
