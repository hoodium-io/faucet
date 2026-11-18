import type { NetworkInfo } from "@/lib/types";

interface HeaderProps {
  network: NetworkInfo | null;
  vaultAddress: string | null;
}

/**
 * Top navigation bar.
 *
 * Left: brand mark and network badge. Right: the network parameters a developer
 * needs to add Hoodium to a wallet (chain ID, currency) plus a copy action.
 *
 * There is no "Connect Wallet" button, and that is intentional: the faucet sends
 * tokens to the address the user types, so it never needs wallet authorisation.
 * Asking to connect would imply a permission the flow does not require.
 */
export function Header({ network, vaultAddress }: HeaderProps) {
  return (
    <header className="border-b border-ink-800">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-500 text-sm font-bold text-ink-950"
            aria-hidden="true"
          >
            R
          </div>

          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight text-white">
              Hoodium Faucet
            </span>
            <span className="text-[11px] leading-tight text-slate-500">
              {network ? network.name : "Connecting…"}
            </span>
          </div>

          {network && (
            <span className="ml-1 rounded-full border border-accent-500/30 bg-accent-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-400">
              {network.key}
            </span>
          )}
        </div>

        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
          {network && (
            <>
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-500">Chain ID</dt>
                <dd className="mono text-slate-300">{network.chainId}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-500">Currency</dt>
                <dd className="mono text-slate-300">{network.nativeCurrency.symbol}</dd>
              </div>
            </>
          )}
          {vaultAddress && (
            <div className="flex items-center gap-1.5">
              <dt className="text-slate-500">Vault</dt>
              <dd className="mono text-slate-300">
                {vaultAddress.slice(0, 6)}…{vaultAddress.slice(-4)}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </header>
  );
}
