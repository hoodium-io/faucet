import {
  Contract,
  type ContractTransactionResponse,
  type Provider,
  type Signer,
  type TransactionResponse,
} from "ethers";
import {
  FAUCET_VAULT_ABI,
  ERC20_ABI,
  NATIVE_TOKEN,
  ROLES,
  type AcceptedToken,
  type RoleName,
  type TokenConfigView,
  type TokenStatusView,
} from "./vaultAbi";

/**
 * Typed façade over `FaucetVault`.
 *
 * Every method maps 1:1 onto a contract function — no business logic lives here.
 * The purpose is that the UI never touches raw ABI strings, so a signature change
 * surfaces as a TypeScript error instead of a runtime revert.
 */
export class AdminVault {
  private readonly contract: Contract;

  constructor(address: string, runner: Provider | Signer) {
    this.contract = new Contract(address, FAUCET_VAULT_ABI, runner);
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** All tokens ever accepted, including disabled ones. */
  async acceptedTokens(): Promise<string[]> {
    return (await this.contract.acceptedTokens()) as string[];
  }

  /** The sentinel address this vault uses for native RUNE. */
  async nativeToken(): Promise<string> {
    return (await this.contract.NATIVE_TOKEN()) as string;
  }

  async paused(): Promise<boolean> {
    return (await this.contract.paused()) as boolean;
  }

  async addressCooldown(): Promise<number> {
    return Number(await this.contract.addressCooldown());
  }

  async uniqueRecipients(): Promise<bigint> {
    return (await this.contract.uniqueRecipients()) as bigint;
  }

  async hasRole(role: RoleName, account: string): Promise<boolean> {
    const roleHash = await this.roleHash(role);
    return (await this.contract.hasRole(roleHash, account)) as boolean;
  }

  /**
   * Resolves a role selector to its bytes32 hash.
   *
   * `role` is the KEY (`"TREASURER"`); the contract getter is the VALUE
   * (`TREASURER_ROLE`). Calling `contract[role]()` with the key would look up a
   * non-existent method and throw at runtime — hence the explicit `ROLES` lookup.
   */
  async roleHash(role: RoleName): Promise<string> {
    const getter = ROLES[role];
    return (await this.contract[getter]()) as string;
  }

  /** Policy + live state for one token. */
  async tokenStatus(token: string): Promise<TokenStatusView> {
    const [cfg, available, dispensedToday, remainingToday] = (await this.contract.tokenStatus(
      token,
    )) as [TokenConfigView, bigint, bigint, bigint];

    return { config: cfg, available, dispensedToday, remainingToday };
  }

  async inventory(token: string): Promise<bigint> {
    return (await this.contract.inventory(token)) as bigint;
  }

  async totalDispensed(token: string): Promise<bigint> {
    return (await this.contract.totalDispensed(token)) as bigint;
  }

  async lastClaimAt(token: string, recipient: string): Promise<bigint> {
    return (await this.contract.lastClaimAt(token, recipient)) as bigint;
  }

  /**
   * Reads symbol/name/decimals for each accepted token.
   *
   * The native sentinel has no ERC-20 metadata, so it is special-cased. A token
   * that reverts on `symbol()` must not break the whole list — hence the guards.
   */
  async describeTokens(provider: Provider): Promise<AcceptedToken[]> {
    const native = await this.nativeToken();
    const addresses = await this.acceptedTokens();

    return Promise.all(
      addresses.map(async (address): Promise<AcceptedToken> => {
        const isNative = address.toLowerCase() === native.toLowerCase();

        if (isNative) {
          return {
            address,
            symbol: "RUNE",
            name: "RUNE (native gas token)",
            decimals: 18,
            isNative: true,
          };
        }

        const erc20 = new Contract(address, ERC20_ABI, provider);

        const [symbol, name, decimals] = await Promise.all([
          erc20.symbol().catch(() => "UNKNOWN"),
          erc20.name().catch(() => "Unknown Token"),
          erc20.decimals().catch(() => 18),
        ]);

        return {
          address,
          symbol: String(symbol),
          name: String(name),
          decimals: Number(decimals),
          isNative: false,
        };
      }),
    );
  }

  // ------------------------------------------------------------------
  // Writes — each requires the matching role on the signing account
  // ------------------------------------------------------------------

  /** TREASURER: deposit native RUNE. */
  async depositNative(value: bigint): Promise<ContractTransactionResponse> {
    return this.contract.depositNative({ value }) as Promise<ContractTransactionResponse>;
  }

  /** TREASURER: deposit an ERC-20. Caller must have approved this vault first. */
  async depositERC20(token: string, amount: bigint): Promise<ContractTransactionResponse> {
    return this.contract.depositERC20(token, amount) as Promise<ContractTransactionResponse>;
  }

  /** TREASURER: withdraw inventory back out. */
  async withdraw(
    token: string,
    to: string,
    amount: bigint,
  ): Promise<ContractTransactionResponse> {
    return this.contract.withdraw(token, to, amount) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: add or update a token's policy. */
  async setTokenConfig(
    token: string,
    cfg: TokenConfigView,
  ): Promise<ContractTransactionResponse> {
    return this.contract.setTokenConfig(token, cfg) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: enable or disable dispensing of a token. */
  async setTokenEnabled(token: string, enabled: boolean): Promise<ContractTransactionResponse> {
    return this.contract.setTokenEnabled(token, enabled) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: set the cross-token cooldown applied to every recipient. */
  async setAddressCooldown(seconds: number): Promise<ContractTransactionResponse> {
    return this.contract.setAddressCooldown(seconds) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: recover a token that was never accepted. */
  async rescue(
    token: string,
    to: string,
    amount: bigint,
  ): Promise<ContractTransactionResponse> {
    return this.contract.rescue(token, to, amount) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: grant a role. */
  async grantRole(role: RoleName, account: string): Promise<ContractTransactionResponse> {
    const hash = await this.roleHash(role);
    return this.contract.grantRole(hash, account) as Promise<ContractTransactionResponse>;
  }

  /** ADMIN: revoke a role. */
  async revokeRole(role: RoleName, account: string): Promise<ContractTransactionResponse> {
    const hash = await this.roleHash(role);
    return this.contract.revokeRole(hash, account) as Promise<ContractTransactionResponse>;
  }

  /** PAUSER: stop dispensing without touching inventory. */
  async pause(): Promise<ContractTransactionResponse> {
    return this.contract.pause() as Promise<ContractTransactionResponse>;
  }

  /** PAUSER: resume dispensing. */
  async unpause(): Promise<ContractTransactionResponse> {
    return this.contract.unpause() as Promise<ContractTransactionResponse>;
  }
}

/**
 * Sends native RUNE to an arbitrary address.
 *
 * WHY THIS IS NOT PART OF `AdminVault`: it is not a vault call. Funding the
 * dispenser is a plain value transfer between EOAs — `vault.depositNative()` sends
 * RUNE *into the vault*, which is a completely different thing and would not give
 * the dispenser gas money.
 *
 * The dispenser signs every claim, so it must hold RUNE. A freshly generated key
 * starts at zero, and nothing in the console could fund it before this existed —
 * the first claim would fail with "insufficient funds" after a deployment that
 * looked successful.
 */
export async function fundAddress(
  signer: Signer,
  to: string,
  amountWei: bigint,
): Promise<TransactionResponse> {
  if (amountWei <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  return signer.sendTransaction({ to, value: amountWei });
}

/** ERC-20 helper bound to one token, for balance display and approval. */
export class Erc20Token {
  private readonly contract: Contract;

  constructor(address: string, runner: Provider | Signer) {
    this.contract = new Contract(address, ERC20_ABI, runner);
  }

  async balanceOf(owner: string): Promise<bigint> {
    return (await this.contract.balanceOf(owner)) as bigint;
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    return (await this.contract.allowance(owner, spender)) as bigint;
  }

  async approve(spender: string, amount: bigint): Promise<ContractTransactionResponse> {
    return this.contract.approve(spender, amount) as Promise<ContractTransactionResponse>;
  }

  /**
   * Reads symbol / name / decimals from the token itself.
   *
   * The admin console used to make the operator type decimals by hand when
   * depositing. That is both error-prone (18 vs 6 silently mis-scales the amount)
   * and unnecessary — `decimals()` is part of the ERC-20 metadata interface. This
   * reads them so the form can show the real values and the operator only supplies
   * the address.
   *
   * Tolerates non-standard tokens: each field falls back rather than throwing, so
   * a token missing `symbol()` still deposits.
   */
  async metadata(): Promise<{ symbol: string; name: string; decimals: number }> {
    const [symbol, name, decimals] = await Promise.all([
      this.contract.symbol().catch(() => "UNKNOWN"),
      this.contract.name().catch(() => "Unknown Token"),
      this.contract.decimals().catch(() => 18),
    ]);

    return {
      symbol: String(symbol),
      name: String(name),
      decimals: Number(decimals),
    };
  }
}

export { NATIVE_TOKEN };
