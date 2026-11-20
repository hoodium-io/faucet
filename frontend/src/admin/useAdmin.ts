import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, type Signer } from "ethers";
import { AdminVault, Erc20Token } from "@/lib/adminVault";
import type { AcceptedToken, RoleName, TokenStatusView } from "@/lib/vaultAbi";
import type { NetworkInfo } from "@/lib/types";
import {
  connectWallet,
  getExistingSigner,
  getWalletChainId,
  hasInjectedWallet,
  switchToChain,
  watchWallet,
} from "@/lib/wallet";

/** A token plus its live on-chain state, as the console renders it. */
export interface TokenRow {
  meta: AcceptedToken;
  status: TokenStatusView;
}

/** Transaction lifecycle, surfaced so the UI can show spinner → hash → done. */
export type TxState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "pending"; hash: string }
  | { kind: "done"; hash: string }
  | { kind: "error"; message: string };

/** Everything the admin console needs, in one hook. */
export interface AdminState {
  // wallet
  walletAvailable: boolean;
  address: string | null;
  signer: Signer | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;

  // roles of the connected address
  roles: Record<RoleName, boolean> | null;

  // vault state
  paused: boolean;
  addressCooldown: number;
  uniqueRecipients: bigint;
  tokens: TokenRow[];
  loading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;

  // transaction helpers
  tx: TxState;
  resetTx: () => void;
  /** Runs a write, tracking its lifecycle. Resolves true on success. */
  submit: (
    label: string,
    action: (vault: AdminVault) => Promise<{ hash: string; wait: () => Promise<unknown> }>,
  ) => Promise<boolean>;

  // typed contracts for the components
  vault: AdminVault | null;
  erc20: (token: string) => Erc20Token | null;
  network: NetworkInfo | null;
  vaultAddress: string;
}

interface Options {
  network: NetworkInfo | null;
  vaultAddress: string;
}

/**
 * Turns a wallet/contract error into an actionable sentence.
 *
 * Without this the operator sees "[ethjs-query] while formatting outputs from
 * RPC ... code=ACTION_REJECTED" — which does not say what to do next.
 */
export function decodeWalletError(error: unknown, label: string): string {
  const err = error as { code?: string | number; shortMessage?: string; message?: string };
  const message = err?.shortMessage ?? err?.message ?? String(error);

  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) {
    return "You rejected the transaction in your wallet.";
  }

  // The contract's own reverts surface by name in the message.
  const known: Array<[string, string]> = [
    [
      "AccessControlUnauthorizedAccount",
      "Your wallet does not hold the role this action requires.",
    ],
    ["EnforcedPause", "The vault is paused."],
    ["ExpectedPause", "The vault is not paused."],
    [
      "InvalidConfig",
      "That configuration is invalid (drip must be > 0 and not exceed max dispense).",
    ],
    ["AmountExceedsMaxDispense", "The amount exceeds the configured max dispense."],
    ["InsufficientInventory", "The vault does not hold enough of that token."],
    ["TokenIsAccepted", "That token is an accepted token — use Withdraw instead of Rescue."],
    ["TokenNotAccepted", "That token is not configured on this vault."],
    ["ZeroAmount", "Amount must be greater than zero."],
    ["ZeroAddress", "That address is not valid."],
    ["DirectDepositDisabled", "Send RUNE with Deposit, not a direct transfer."],
  ];

  for (const [needle, readable] of known) {
    if (message.includes(needle)) return readable;
  }

  if (message.toLowerCase().includes("insufficient funds")) {
    return "Your wallet has insufficient RUNE to pay for gas.";
  }

  return `${label} failed: ${message}`;
}

/**
 * Central state for the admin console.
 *
 * Design notes:
 * - Reads use a plain provider, so the console can *display* vault state without
 *   a wallet connection. Writes require a signer, hence the explicit connect step.
 * - A wallet on the wrong chain is a first-class state, not an error message: the
 *   UI offers a one-click switch, because Hoodium is not in any wallet's default
 *   network list.
 * - Roles are read for the *connected* address, so the UI can disable actions the
 *   operator cannot perform instead of letting them fail in the wallet.
 */
export function useAdmin({ network, vaultAddress }: Options): AdminState {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [roles, setRoles] = useState<Record<RoleName, boolean> | null>(null);

  const [paused, setPaused] = useState(false);
  const [addressCooldown, setAddressCooldown] = useState(0);
  const [uniqueRecipients, setUniqueRecipients] = useState<bigint>(0n);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tx, setTx] = useState<TxState>({ kind: "idle" });

  const walletAvailable = useMemo(() => hasInjectedWallet(), []);
  const wrongNetwork =
    walletChainId !== null && network !== null && walletChainId !== network.chainId;

  /**
   * Read provider. Uses the injected wallet when present so reads work against
   * whatever chain the operator is on.
   */
  const readProvider = useMemo(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      return new BrowserProvider(window.ethereum);
    }
    return null;
  }, []);

  const vault = useMemo(() => {
    const runner = signer ?? readProvider;
    if (!runner || !vaultAddress) return null;
    return new AdminVault(vaultAddress, runner);
  }, [signer, readProvider, vaultAddress]);

  const erc20 = useCallback(
    (token: string) => {
      const runner = signer ?? readProvider;
      if (!runner) return null;
      return new Erc20Token(token, runner);
    },
    [signer, readProvider],
  );

  /** Re-reads everything from the chain. */
  const refresh = useCallback(async () => {
    if (!vault || !readProvider) return;

    setLoadError(null);

    try {
      const [isPaused, cooldown, unique, metas] = await Promise.all([
        vault.paused(),
        vault.addressCooldown(),
        vault.uniqueRecipients(),
        vault.describeTokens(readProvider),
      ]);

      const rows = await Promise.all(
        metas.map(async (meta): Promise<TokenRow> => {
          const status = await vault.tokenStatus(meta.address);
          return { meta, status };
        }),
      );

      let roleChecks: Record<RoleName, boolean> | null = null;
      if (address) {
        const results = await Promise.all(
          (["ADMIN", "DISPENSER", "TREASURER", "PAUSER"] as const).map(
            async (role) => [role, await vault.hasRole(role, address)] as const,
          ),
        );
        roleChecks = Object.fromEntries(results) as Record<RoleName, boolean>;
      }

      setPaused(isPaused);
      setAddressCooldown(cooldown);
      setUniqueRecipients(unique);
      setTokens(rows);
      setRoles(roleChecks);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to read vault state.");
    } finally {
      setLoading(false);
    }
  }, [vault, readProvider, address]);

  // Initial read, and a re-read whenever the wallet address changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Restore an already-authorised wallet without prompting.
  useEffect(() => {
    if (!walletAvailable) {
      setLoading(false);
      return;
    }

    void (async () => {
      const existing = await getExistingSigner().catch(() => null);
      if (existing) {
        setSigner(existing);
        setAddress(await existing.getAddress());
        setWalletChainId(await getWalletChainId());
      }
    })();
  }, [walletAvailable]);

  // React to the operator changing account or network inside the wallet.
  useEffect(() => {
    if (!walletAvailable) return;

    return watchWallet(() => {
      void (async () => {
        setWalletChainId(await getWalletChainId().catch(() => null));

        const existing = await getExistingSigner().catch(() => null);
        setSigner(existing);
        setAddress(existing ? await existing.getAddress() : null);
      })();
    });
  }, [walletAvailable]);

  const connect = useCallback(async () => {
    setConnecting(true);

    try {
      const { signer: s, address: a } = await connectWallet();
      setSigner(s);
      setAddress(a);
      setWalletChainId(await getWalletChainId());
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!network) return;

    await switchToChain(network.chainId, network.rpcUrl, {
      name: network.name,
      symbol: network.nativeCurrency.symbol,
      decimals: network.nativeCurrency.decimals,
      explorerUrl: network.explorerUrl,
    });

    setWalletChainId(await getWalletChainId());
  }, [network]);

  /**
   * Runs a write and tracks it through sign → pending → done.
   *
   * Returns false when the operator rejects or the transaction reverts, so callers
   * avoid showing success on failure.
   */
  const submit = useCallback<AdminState["submit"]>(
    async (label, action) => {
      if (!vault) {
        setTx({ kind: "error", message: "Vault is not connected." });
        return false;
      }

      setTx({ kind: "signing" });

      try {
        const response = await action(vault);

        setTx({ kind: "pending", hash: response.hash });

        await response.wait();
        setTx({ kind: "done", hash: response.hash });

        await refresh();
        return true;
      } catch (error) {
        setTx({ kind: "error", message: decodeWalletError(error, label) });
        return false;
      }
    },
    [vault, refresh],
  );

  const resetTx = useCallback(() => setTx({ kind: "idle" }), []);

  return {
    walletAvailable,
    address,
    signer,
    walletChainId,
    wrongNetwork,
    connecting,
    connect,
    switchNetwork,
    roles,
    paused,
    addressCooldown,
    uniqueRecipients,
    tokens,
    loading,
    loadError,
    refresh,
    tx,
    resetTx,
    submit,
    vault,
    erc20,
    network,
    vaultAddress,
  };
}
