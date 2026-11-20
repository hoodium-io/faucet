import { useState } from "react";
import { parseUnits, formatUnits } from "ethers";
import type { AdminState, TokenRow } from "./useAdmin";
import { Panel, Field } from "./parts";
import { formatAmount } from "@/lib/format";
import type { TokenConfigView } from "@/lib/vaultAbi";

/** Formats a base-unit amount for display. */
function fmt(value: bigint, decimals: number): string {
  return formatAmount(formatUnits(value, decimals));
}

/**
 * Decimal hours → `bigint` seconds, clamped to the contract's `uint32` range.
 *
 * `TokenConfig.cooldown` is `uint32`, and ethers decodes it as `bigint`. Returning
 * a plain `number` would both fail type-checking and risk a value the contract
 * cannot represent — so the conversion is explicit and bounded here rather than
 * left to fail in the wallet.
 */
function cooldownSeconds(hours: string): bigint {
  const parsed = Number(hours);
  const seconds = Number.isFinite(parsed) ? Math.round(parsed * 3600) : 0;

  // uint32 max = 4294967295s (~136 years). Clamp rather than overflow.
  const clamped = Math.min(Math.max(seconds, 0), 4_294_967_295);

  return BigInt(clamped);
}

/** Small metric row. */
function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="mono text-xs text-slate-200">{value}</dd>
    </div>
  );
}

/**
 * Per-token policy editor and live status.
 *
 * The console's most important panel: drip size, max dispense, cooldown and the
 * rolling 24h cap all live on-chain, so this is the only way to change them
 * without a block explorer.
 *
 * Each row edits in place and sends one `setTokenConfig` per save, because the
 * contract takes the whole struct at once — partial updates are not possible, so
 * the form is seeded from the current on-chain values and the operator edits what
 * they want to change.
 */
export function PolicyPanel({ admin }: { admin: AdminState }) {
  const { tokens } = admin;

  return (
    <Panel
      title="Token policy"
      description="Drip, ceiling, cooldown and daily cap are enforced on-chain. Changes require DEFAULT_ADMIN_ROLE."
    >
      {tokens.length === 0 ? (
        <p className="text-xs text-slate-500">
          No tokens configured yet. Seed the vault or add one below.
        </p>
      ) : (
        <div className="space-y-4">
          {tokens.map((row) => (
            <TokenPolicyRow key={row.meta.address} row={row} admin={admin} />
          ))}
        </div>
      )}

      <AddTokenForm admin={admin} />
    </Panel>
  );
}

/** One token's editable policy plus its live counters. */
function TokenPolicyRow({ row, admin }: { row: TokenRow; admin: AdminState }) {
  const { meta, status } = row;
  const [editing, setEditing] = useState(false);

  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const toggleEnabled = async () => {
    await admin.submit("Toggle token", (v) =>
      v.setTokenEnabled(meta.address, !status.config.enabled),
    );
  };

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{meta.symbol}</span>
            {meta.isNative && (
              <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-400">
                Gas
              </span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                status.config.enabled
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-ink-700 text-slate-400"
              }`}
            >
              {status.config.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mono mt-0.5 text-[11px] text-slate-500">{meta.address}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent-500/50 hover:text-accent-300"
          >
            {editing ? "Close" : "Edit policy"}
          </button>
          <button
            type="button"
            onClick={() => void toggleEnabled()}
            disabled={!canWrite}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent-500/50 hover:text-accent-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status.config.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <Counter label="Inventory" value={fmt(status.available, meta.decimals)} />
        <Counter label="Dispensed today" value={fmt(status.dispensedToday, meta.decimals)} />
        <Counter
          label="Left today"
          value={
            status.config.dailyCap === 0n ? "uncapped" : fmt(status.remainingToday, meta.decimals)
          }
        />
        <Counter label="Cooldown" value={`${Number(status.config.cooldown)}s`} />
      </dl>

      {editing && <PolicyEditor row={row} admin={admin} />}
    </div>
  );
}

/** The editable form, seeded from current on-chain values. */
function PolicyEditor({ row, admin }: { row: TokenRow; admin: AdminState }) {
  const { meta, status } = row;
  const d = meta.decimals;

  const [enabled, setEnabled] = useState(status.config.enabled);
  const [drip, setDrip] = useState(formatUnits(status.config.dripAmount, d));
  const [maxDispense, setMaxDispense] = useState(formatUnits(status.config.maxDispense, d));
  const [cooldownHours, setCooldownHours] = useState(
    String(Number(status.config.cooldown) / 3600),
  );
  const [dailyCap, setDailyCap] = useState(formatUnits(status.config.dailyCap, d));

  const [error, setError] = useState<string | null>(null);

  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const save = async () => {
    setError(null);

    let cfg: TokenConfigView;
    try {
      const dripAmount = parseUnits(drip.trim() || "0", d);
      const maxDispenseAmount = parseUnits(maxDispense.trim() || "0", d);
      const cap = parseUnits(dailyCap.trim() || "0", d);

      // Mirror the contract's own validation, so the operator sees the message
      // here instead of after paying gas for a revert.
      if (maxDispenseAmount === 0n) {
        setError("Max dispense must be greater than zero.");
        return;
      }
      if (enabled && dripAmount > maxDispenseAmount) {
        setError("Drip amount cannot exceed max dispense.");
        return;
      }

      cfg = {
        enabled,
        dripAmount,
        maxDispense: maxDispenseAmount,
        cooldown: cooldownSeconds(cooldownHours),
        dailyCap: cap,
      };
    } catch {
      setError("One of the amounts is not a valid number.");
      return;
    }

    await admin.submit("Save policy", (v) => v.setTokenConfig(meta.address, cfg));
  };

  return (
    <div className="mt-4 space-y-3 border-t border-ink-700 pt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Drip per claim">
          <input
            className="faucet-input mono"
            value={drip}
            onChange={(e) => setDrip(e.target.value)}
            inputMode="decimal"
          />
        </Field>

        <Field label="Max dispense" hint="Hard ceiling for one dispense.">
          <input
            className="faucet-input mono"
            value={maxDispense}
            onChange={(e) => setMaxDispense(e.target.value)}
            inputMode="decimal"
          />
        </Field>

        <Field label="Cooldown (hours)" hint="Per recipient, per token.">
          <input
            className="faucet-input mono"
            value={cooldownHours}
            onChange={(e) => setCooldownHours(e.target.value)}
            inputMode="decimal"
          />
        </Field>

        <Field label="Daily cap" hint="0 means uncapped.">
          <input
            className="faucet-input mono"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            inputMode="decimal"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-ink-600 bg-ink-800 accent-accent-500"
        />
        Enabled
      </label>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={!canWrite}
        className="faucet-button sm:w-auto sm:px-6"
      >
        {busy ? "Working…" : "Save policy"}
      </button>
    </div>
  );
}

/** Adds a token that the vault does not know about yet. */
function AddTokenForm({ admin }: { admin: AdminState }) {
  const [address, setAddress] = useState("");
  const [drip, setDrip] = useState("");
  const [maxDispense, setMaxDispense] = useState("");
  const [cooldownHours, setCooldownHours] = useState("24");
  const [dailyCap, setDailyCap] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [error, setError] = useState<string | null>(null);

  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const add = async () => {
    setError(null);

    const d = Number(decimals);

    let cfg: TokenConfigView;
    try {
      const dripAmount = parseUnits(drip.trim() || "0", d);
      const maxDispenseAmount = parseUnits(maxDispense.trim() || "0", d);
      const cap = parseUnits(dailyCap.trim() || "0", d);

      if (maxDispenseAmount === 0n) {
        setError("Max dispense must be greater than zero.");
        return;
      }
      if (dripAmount > maxDispenseAmount) {
        setError("Drip amount cannot exceed max dispense.");
        return;
      }

      cfg = {
        enabled: true,
        dripAmount,
        maxDispense: maxDispenseAmount,
        cooldown: cooldownSeconds(cooldownHours),
        dailyCap: cap,
      };
    } catch {
      setError("One of the amounts is not a valid number.");
      return;
    }

    const ok = await admin.submit("Add token", (v) => v.setTokenConfig(address, cfg));
    if (ok) {
      setAddress("");
      setDrip("");
      setMaxDispense("");
      setDailyCap("");
    }
  };

  return (
    <div className="mt-6 space-y-3 border-t border-ink-700 pt-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        Add a token
      </h3>
      <p className="text-[11px] text-slate-500">
        Registers a token and its policy. It becomes dispensable immediately, so deposit inventory
        first if you do not want early claims to fail.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Token address" hint="Use 0x000…000 for native RUNE.">
          <input
            className="faucet-input mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </Field>

        <Field label="Decimals">
          <input
            className="faucet-input mono"
            value={decimals}
            onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
          />
        </Field>

        <Field label="Drip per claim">
          <input
            className="faucet-input mono"
            value={drip}
            onChange={(e) => setDrip(e.target.value)}
            placeholder="1"
            inputMode="decimal"
          />
        </Field>

        <Field label="Max dispense">
          <input
            className="faucet-input mono"
            value={maxDispense}
            onChange={(e) => setMaxDispense(e.target.value)}
            placeholder="1"
            inputMode="decimal"
          />
        </Field>

        <Field label="Cooldown (hours)">
          <input
            className="faucet-input mono"
            value={cooldownHours}
            onChange={(e) => setCooldownHours(e.target.value)}
            inputMode="decimal"
          />
        </Field>

        <Field label="Daily cap" hint="0 means uncapped.">
          <input
            className="faucet-input mono"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            placeholder="500"
            inputMode="decimal"
          />
        </Field>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void add()}
        disabled={!canWrite || address.trim() === ""}
        className="faucet-button sm:w-auto sm:px-6"
      >
        Add token
      </button>
    </div>
  );
}
