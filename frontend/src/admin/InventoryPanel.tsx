import { useState } from "react";
import { parseUnits, formatUnits, isAddress } from "ethers";
import type { AdminState } from "./useAdmin";
import { Panel, Field } from "./parts";
import { formatAmount } from "@/lib/format";
import { NATIVE_TOKEN } from "@/lib/vaultAbi";

/**
 * Parses a decimal amount, returning null on bad input.
 * Shared by both deposit paths so the guard cannot drift.
 */
function safeParseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  try {
    const parsed = parseUnits(trimmed, decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Inventory management.
 *
 * Covers the three treasurer actions: deposit native RUNE, deposit an ERC-20, and
 * withdraw. The ERC-20 path is two transactions (approve, then deposit) because
 * that is what the token standard requires — the panel says so rather than
 * silently doing both, so the operator knows they will sign twice.
 */
export function InventoryPanel({ admin }: { admin: AdminState }) {
  const { tokens, vaultAddress, submit, tx, erc20, address } = admin;

  const [nativeAmount, setNativeAmount] = useState("");
  const [erc20Address, setErc20Address] = useState("");
  const [erc20Amount, setErc20Amount] = useState("");
  // Auto-read from the token when the address is valid — see `lookupToken` below.
  const [tokenMeta, setTokenMeta] = useState<{
    symbol: string;
    name: string;
    decimals: number;
  } | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [withdrawToken, setWithdrawToken] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const busy = tx.kind === "signing" || tx.kind === "pending";
  const canWrite = Boolean(address) && !admin.wrongNetwork && !busy;

  /**
   * Reads symbol/name/decimals from the token contract.
   *
   * The operator previously had to type decimals by hand, which silently mis-scales
   * the deposit if wrong (18 vs 6 is a 10^12 error). The token knows its own
   * decimals, so this asks it.
   */
  const lookupToken = async (candidate: string) => {
    if (!isAddress(candidate)) {
      setTokenMeta(null);
      setMetaError(null);
      return;
    }

    const token = erc20(candidate);
    if (!token) return;

    setMetaLoading(true);
    setMetaError(null);
    setTokenBalance(null);

    try {
      const meta = await token.metadata();
      setTokenMeta(meta);

      // A readable symbol is a good signal the address really is an ERC-20 —
      // a plain EOA or a random contract returns nothing.
      if (meta.symbol === "UNKNOWN") {
        setMetaError("That address does not look like an ERC-20 (no symbol()).");
        return;
      }

      // Show what the operator actually holds — a deposit above this will revert.
      if (address) {
        const bal = await token.balanceOf(address).catch(() => null);
        setTokenBalance(bal);
      }
    } catch {
      setTokenMeta(null);
      setMetaError("Could not read token metadata from that address.");
    } finally {
      setMetaLoading(false);
    }
  };

  /** Deposits native RUNE. */
  const handleDepositNative = async () => {
    const value = safeParseUnits(nativeAmount, 18);
    if (value === null) return;

    const ok = await submit("Deposit RUNE", (v) => v.depositNative(value));
    if (ok) setNativeAmount("");
  };

  /**
   * Approves then deposits an ERC-20.
   *
   * Approval is skipped when a sufficient allowance already exists, so repeat
   * deposits cost one signature instead of two.
   */
  const handleDepositErc20 = async () => {
    if (!isAddress(erc20Address) || !tokenMeta) return;

    const amount = safeParseUnits(erc20Amount, tokenMeta.decimals);
    if (amount === null) return;

    const token = erc20(erc20Address);
    if (!token || !address) return;

    const allowance = await token.allowance(address, vaultAddress).catch(() => 0n);

    if (allowance < amount) {
      const approved = await submit("Approve token", () => token.approve(vaultAddress, amount));
      if (!approved) return;
    }

    const ok = await submit("Deposit token", (v) => v.depositERC20(erc20Address, amount));
    if (ok) setErc20Amount("");
  };

  /** Withdraws inventory. */
  const handleWithdraw = async () => {
    const row = tokens.find(
      (t) => t.meta.address.toLowerCase() === withdrawToken.toLowerCase(),
    );
    const decimals = row?.meta.decimals ?? 18;

    const amount = safeParseUnits(withdrawAmount, decimals);
    if (amount === null || !isAddress(withdrawTo)) return;

    const ok = await submit("Withdraw", (v) => v.withdraw(withdrawToken, withdrawTo, amount));
    if (ok) setWithdrawAmount("");
  };

  return (
    <Panel
      title="Inventory"
      description="Deposits require TREASURER_ROLE. Depositing is allowed while the vault is paused."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- Native RUNE ---------------- */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Deposit RUNE
          </h3>

          <Field
            label="Amount (RUNE)"
            hint="Calls depositNative(), which emits the deposit event."
          >
            <input
              className="faucet-input mono"
              value={nativeAmount}
              onChange={(e) => setNativeAmount(e.target.value)}
              placeholder="100"
              inputMode="decimal"
            />
          </Field>

          <button
            type="button"
            onClick={() => void handleDepositNative()}
            disabled={!canWrite || nativeAmount.trim() === ""}
            className="faucet-button"
          >
            Deposit RUNE
          </button>

          <p className="text-[11px] text-slate-500">
            Do not send RUNE with a plain transfer from a non-treasurer account —{" "}
            <span className="mono">receive()</span> rejects it.
          </p>
        </div>

        {/* ---------------- ERC-20 ---------------- */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Deposit ERC-20
          </h3>

          <Field label="Token address">
            <input
              className="faucet-input mono"
              value={erc20Address}
              onChange={(e) => {
                setErc20Address(e.target.value);
                void lookupToken(e.target.value);
              }}
              placeholder="0x…"
              spellCheck={false}
            />
          </Field>

          {/* Decimals/symbol come from the contract, so they cannot be mistyped. */}
          {metaLoading && <p className="text-[11px] text-slate-500">Reading token…</p>}

          {metaError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {metaError}
            </p>
          )}

          {tokenMeta && !metaError && (
            <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{tokenMeta.symbol}</span> ·{" "}
              {tokenMeta.name} ·{" "}
              <span className="mono">{tokenMeta.decimals}</span> decimals
              {tokenBalance !== null && (
                <>
                  {" · your balance "}
                  <span className="mono">
                    {formatAmount(formatUnits(tokenBalance, tokenMeta.decimals))}
                  </span>
                </>
              )}
            </p>
          )}

          <Field label="Amount" hint="In whole units — decimals are applied automatically.">
            <input
              className="faucet-input mono"
              value={erc20Amount}
              onChange={(e) => setErc20Amount(e.target.value)}
              placeholder="250000"
              inputMode="decimal"
            />
          </Field>

          <button
            type="button"
            onClick={() => void handleDepositErc20()}
            disabled={
              !canWrite ||
              !isAddress(erc20Address) ||
              !tokenMeta ||
              Boolean(metaError) ||
              erc20Amount.trim() === ""
            }
            className="faucet-button"
          >
            Approve &amp; deposit
          </button>

          <p className="text-[11px] text-slate-500">
            Two signatures on the first deposit (approve, then deposit); one afterwards if the
            allowance still covers the amount.
          </p>
        </div>

        {/* ---------------- Withdraw ---------------- */}
        <div className="space-y-3 lg:col-span-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Withdraw inventory
          </h3>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Token">
              <select
                className="faucet-input"
                value={withdrawToken}
                onChange={(e) => setWithdrawToken(e.target.value)}
              >
                <option value="">Select a token…</option>
                {tokens.map((row) => (
                  <option key={row.meta.address} value={row.meta.address}>
                    {row.meta.symbol} — {formatAmount(String(row.status.available))}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Recipient">
              <input
                className="faucet-input mono"
                value={withdrawTo}
                onChange={(e) => setWithdrawTo(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </Field>

            <Field label="Amount">
              <input
                className="faucet-input mono"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0"
                inputMode="decimal"
              />
            </Field>
          </div>

          <button
            type="button"
            onClick={() => void handleWithdraw()}
            disabled={
              !canWrite || !withdrawToken || !isAddress(withdrawTo) || withdrawAmount.trim() === ""
            }
            className="faucet-button"
          >
            Withdraw
          </button>

          <p className="text-[11px] text-slate-500">
            To withdraw RUNE, select the native token entry. Its address is the sentinel{" "}
            <span className="mono">{NATIVE_TOKEN}</span>.
          </p>
        </div>
      </div>
    </Panel>
  );
}
