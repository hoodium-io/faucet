import { BrowserProvider, type Eip1193Provider, type Signer } from "ethers";

/**
 * Minimal EIP-1193 provider type.
 *
 * Typed locally rather than depending on `window.ethereum` declarations, so the
 * admin console works with any injected wallet (MetaMask, Rabby, Frame, Coinbase)
 * without pulling in a wallet SDK.
 */
export interface InjectedProvider extends Eip1193Provider {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

/** Whether an injected wallet is present at all. */
export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/**
 * Requests account access and returns a signer.
 *
 * `eth_requestAccounts` is the only call here that prompts the user. Everything
 * after it is read-only until an admin action is submitted, so connecting costs
 * the operator one approval and no transaction.
 */
export async function connectWallet(): Promise<{ signer: Signer; address: string }> {
  if (!window.ethereum) {
    throw new Error(
      "No browser wallet detected. Install MetaMask, Rabby or Frame to use the admin console.",
    );
  }

  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  return { signer, address };
}

/** Returns a signer for an already-authorised wallet, without prompting. */
export async function getExistingSigner(): Promise<Signer | null> {
  if (!window.ethereum) return null;

  const provider = new BrowserProvider(window.ethereum);
  const accounts = (await provider.send("eth_accounts", [])) as string[];

  if (!accounts || accounts.length === 0) return null;

  return provider.getSigner();
}

/** Current chain ID reported by the wallet, as a number. */
export async function getWalletChainId(): Promise<number | null> {
  if (!window.ethereum) return null;

  const provider = new BrowserProvider(window.ethereum);
  const network = await provider.getNetwork();
  return Number(network.chainId);
}

/**
 * Asks the wallet to switch to `chainId`, adding the chain first if the wallet
 * does not know it.
 *
 * Two-step by necessity: `wallet_switchEthereumChain` fails with code 4902 when
 * the chain is unknown, and only then may `wallet_addEthereumChain` be called.
 * Hoodium is not in any wallet's default list, so this path is the normal one.
 */
export async function switchToChain(
  chainId: number,
  rpcUrl: string,
  meta: { name: string; symbol: string; decimals: number; explorerUrl: string | null },
): Promise<void> {
  if (!window.ethereum) throw new Error("No browser wallet detected.");

  const hexChainId = `0x${chainId.toString(16)}`;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
    return;
  } catch (error) {
    const code = (error as { code?: number }).code;

    // 4902 = chain not added to the wallet yet.
    if (code !== 4902) {
      throw new Error(
        code === 4001
          ? "You rejected the network switch in your wallet."
          : `Could not switch network: ${(error as Error).message}`,
      );
    }
  }

  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: hexChainId,
        chainName: meta.name,
        nativeCurrency: {
          name: meta.symbol,
          symbol: meta.symbol,
          decimals: meta.decimals,
        },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: meta.explorerUrl ? [meta.explorerUrl] : [],
      },
    ],
  });
}

/** Subscribes to wallet account/chain changes. Returns an unsubscribe function. */
export function watchWallet(onChange: () => void): () => void {
  const eth = window.ethereum;
  if (!eth?.on) return () => undefined;

  eth.on("accountsChanged", onChange);
  eth.on("chainChanged", onChange);

  return () => {
    eth.removeListener?.("accountsChanged", onChange);
    eth.removeListener?.("chainChanged", onChange);
  };
}
