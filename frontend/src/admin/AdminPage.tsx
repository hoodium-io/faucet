import { useEffect, useState } from "react";
import { fetchTokens } from "@/lib/api";
import type { NetworkInfo } from "@/lib/types";
import { useAdmin } from "./useAdmin";
import { TxBanner } from "./parts";
import { WalletPanel } from "./WalletPanel";
import { OverviewPanel, ControlsPanel, RolesPanel, RescuePanel, FundWalletPanel } from "./ControlsPanel";
import { InventoryPanel } from "./InventoryPanel";
import { PolicyPanel } from "./PolicyPanel";

/**
 * Admin console.
 *
 * A separate route inside the same SPA (`#/admin`) rather than a separate app:
 * it shares the design system and the API client, and needs no router dependency
 * — hash routing is enough for two pages.
 *
 * IMPORTANT: this page holds **no keys**. Every write is signed by the operator's
 * browser wallet, which is the only holder of a role-bearing key. The faucet
 * backend's dispenser key is never involved.
 */
export function AdminPage() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [vaultAddress, setVaultAddress] = useState<string>("");
  const [dispenserAddress, setDispenserAddress] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  // The vault address and network metadata come from the API, so the console
  // cannot be pointed at a different vault than the one the backend serves.
  useEffect(() => {
    const controller = new AbortController();

    fetchTokens(controller.signal)
      .then((data) => {
        setNetwork(data.network);
        setVaultAddress(data.vaultAddress);
        setDispenserAddress(data.dispenserAddress ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setBootstrapError(
          error instanceof Error ? error.message : "Could not load faucet configuration.",
        );
      });

    return () => controller.abort();
  }, []);

  const admin = useAdmin({ network, vaultAddress, dispenserAddress });

  return (
    <div className="min-h-screen bg-ink-950">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-500 text-sm font-bold text-ink-950"
              aria-hidden="true"
            >
              R
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold leading-tight text-white">Faucet admin</span>
              <span className="text-[11px] leading-tight text-slate-500">
                {network ? `${network.name} · chain ${network.chainId}` : "Loading…"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void admin.refresh()}
              disabled={admin.loading}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent-500/50 hover:text-accent-300 disabled:opacity-50"
            >
              {admin.loading ? "Refreshing…" : "Refresh"}
            </button>
            <a
              href="#/"
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent-500/50 hover:text-accent-300"
            >
              ← Faucet
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-6">
        {bootstrapError ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5" role="alert">
            <h1 className="text-sm font-semibold text-red-300">Cannot load configuration</h1>
            <p className="mt-1 text-xs text-slate-400">{bootstrapError}</p>
            <p className="mt-3 text-xs text-slate-500">
              The console reads the vault address from{" "}
              <span className="mono">/api/faucet/tokens</span>. Check that the backend is running.
            </p>
          </div>
        ) : !vaultAddress ? (
          <div className="rounded-2xl border border-ink-700 bg-ink-900 p-8 text-center text-sm text-slate-500">
            Loading vault…
          </div>
        ) : (
          <>
            <Banner paused={admin.paused} />

            <TxBanner state={admin.tx} onDismiss={admin.resetTx} />

            {admin.loadError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
                {admin.loadError}
                <button
                  type="button"
                  onClick={() => void admin.refresh()}
                  className="ml-2 underline hover:text-red-100"
                >
                  Retry
                </button>
              </div>
            )}

            <OverviewPanel admin={admin} />
            <WalletPanel admin={admin} />
            <ControlsPanel admin={admin} />
            <FundWalletPanel admin={admin} />
            <PolicyPanel admin={admin} />
            <InventoryPanel admin={admin} />
            <RolesPanel admin={admin} />
            <RescuePanel admin={admin} />

            <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
              Every action here is an on-chain transaction signed by your wallet. This page holds
              no private keys and no privileged access of its own — removing the page changes
              nothing about the vault's security.
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** Loud banner when dispensing is paused, since that is the most likely surprise. */
function Banner({ paused }: { paused: boolean }) {
  if (!paused) return null;

  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-200">
      Dispensing is <strong>paused</strong>. Public claims are currently rejected. Resume from the
      Controls panel below.
    </div>
  );
}
