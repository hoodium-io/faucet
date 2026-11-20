import type { AdminState } from "./useAdmin";
import { Panel, RoleBadge, Stat } from "./parts";
import { shortenAddress } from "@/lib/format";

/**
 * Wallet connection and role visibility.
 *
 * Shows *before* anything else, because every write action needs a signer on the
 * right chain holding the right role. Making that state explicit up front stops
 * the operator from filling in a form that was always going to fail.
 */
export function WalletPanel({ admin }: { admin: AdminState }) {
  const { address, roles, walletAvailable, wrongNetwork, connecting, network } = admin;

  return (
    <Panel
      title="Operator wallet"
      description="Admin actions are signed by your browser wallet. Keys never reach this app."
      action={
        address ? (
          <span className="mono rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-slate-300">
            {shortenAddress(address)}
          </span>
        ) : null
      }
    >
      {!walletAvailable ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          No browser wallet detected. Install MetaMask, Rabby or Frame to manage the vault.
          You can still read vault state below.
        </p>
      ) : !address ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">
            Connect a wallet that holds the vault's admin, treasurer or pauser role.
          </p>
          <button
            type="button"
            onClick={() => void admin.connect()}
            disabled={connecting}
            className="faucet-button sm:w-auto sm:px-6"
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {wrongNetwork && (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-amber-200">
                Your wallet is on chain {admin.walletChainId}, but this vault lives on{" "}
                {network?.name ?? "another network"} ({network?.chainId ?? "?"}).
              </p>
              <button
                type="button"
                onClick={() => void admin.switchNetwork()}
                className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-400"
              >
                Switch to {network?.name ?? "network"}
              </button>
            </div>
          )}

          <div>
            <span className="faucet-label mb-2 block">Roles held by this address</span>
            {roles ? (
              <div className="flex flex-wrap gap-2">
                <RoleBadge name="DEFAULT_ADMIN_ROLE" held={roles.DEFAULT_ADMIN_ROLE} />
                <RoleBadge name="TREASURER_ROLE" held={roles.TREASURER_ROLE} />
                <RoleBadge name="PAUSER_ROLE" held={roles.PAUSER_ROLE} />
                <RoleBadge name="DISPENSER_ROLE" held={roles.DISPENSER_ROLE} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">Reading roles…</p>
            )}
          </div>

          {roles && !roles.DEFAULT_ADMIN_ROLE && !roles.TREASURER_ROLE && !roles.PAUSER_ROLE && (
            <p className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-xs text-slate-400">
              This address holds no management role. Vault state is visible, but every write
              action will revert. Connect the admin, treasurer or pauser account.
            </p>
          )}

          <div className="grid gap-x-6 sm:grid-cols-2">
            <Stat label="Wallet chain" value={admin.walletChainId ?? "—"} />
            <Stat label="Vault" value={<span>{shortenAddress(admin.vaultAddress)}</span>} />
          </div>
        </div>
      )}
    </Panel>
  );
}
