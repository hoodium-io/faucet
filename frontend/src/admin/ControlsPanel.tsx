import { useState } from "react";
import { isAddress, parseUnits } from "ethers";
import type { AdminState } from "./useAdmin";
import { Panel, Field, Stat } from "./parts";
import type { RoleName } from "@/lib/vaultAbi";

const ROLE_OPTIONS: Array<{ key: RoleName; label: string }> = [
  { key: "ADMIN", label: "Default admin" },
  { key: "TREASURER", label: "Treasurer" },
  { key: "PAUSER", label: "Pauser" },
  { key: "DISPENSER", label: "Dispenser" },
];

/** Compact overview shown at the top of the console. */
export function OverviewPanel({ admin }: { admin: AdminState }) {
  return (
    <Panel title="Vault overview">
      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Vault" value={<span className="break-all">{admin.vaultAddress}</span>} />
        <Stat label="Network" value={admin.network?.name ?? "—"} />
        <Stat label="Chain ID" value={admin.network?.chainId ?? "—"} />
        <Stat label="Unique recipients" value={admin.uniqueRecipients.toString()} />
      </div>
    </Panel>
  );
}

/**
 * Operational controls: pause/resume, the cross-token cooldown, role grants and
 * stray-token rescue.
 *
 * Grouped together because they are the things an operator reaches for during an
 * incident.
 */
export function ControlsPanel({ admin }: { admin: AdminState }) {
  const { paused } = admin;
  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const [cooldownHours, setCooldownHours] = useState(
    admin.addressCooldown > 0 ? String(admin.addressCooldown / 3600) : "0",
  );

  const saveCooldown = async () => {
    const seconds = Math.max(0, Math.round(Number(cooldownHours) * 3600));
    await admin.submit("Set address cooldown", (v) => v.setAddressCooldown(seconds));
  };

  return (
    <Panel title="Controls" description="Incident response and access management.">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- Pause ---------------- */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Dispensing state
          </h3>

          <div
            className={`rounded-xl border px-4 py-3 ${
              paused
                ? "border-red-500/40 bg-red-500/10"
                : "border-emerald-500/30 bg-emerald-500/10"
            }`}
          >
            <p className={`text-sm font-semibold ${paused ? "text-red-300" : "text-emerald-300"}`}>
              {paused ? "Paused — claims are rejected" : "Active — claims are being served"}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Pausing blocks <span className="mono">dispense()</span> but still allows inventory
              deposits, so you can top up during an incident.
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              void admin.submit(paused ? "Unpause" : "Pause", (v) =>
                paused ? v.unpause() : v.pause(),
              )
            }
            disabled={!canWrite}
            className={`w-full rounded-xl px-4 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              paused
                ? "bg-emerald-500 text-ink-950 hover:bg-emerald-400"
                : "bg-red-500 text-white hover:bg-red-400"
            }`}
          >
            {paused ? "Resume dispensing" : "Pause dispensing"}
          </button>
        </div>

        {/* ---------------- Cross-token cooldown ---------------- */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Cross-token cooldown
          </h3>
          <p className="text-[11px] text-slate-500">
            Stops one address claiming every token in a single block. Applies on top of each
            token's own cooldown. <span className="mono">0</span> disables it.
          </p>

          <Field label="Cooldown (hours)">
            <input
              className="faucet-input mono"
              value={cooldownHours}
              onChange={(e) => setCooldownHours(e.target.value)}
              inputMode="decimal"
            />
          </Field>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void saveCooldown()}
              disabled={!canWrite}
              className="rounded-xl bg-accent-500 px-4 py-2 text-xs font-semibold text-ink-950 hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save cooldown
            </button>
            <span className="text-[11px] text-slate-500">
              Current: <span className="mono text-slate-300">{admin.addressCooldown}s</span>
            </span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Access control: grant and revoke roles. */
export function RolesPanel({ admin }: { admin: AdminState }) {
  const [roleKey, setRoleKey] = useState<RoleName>("TREASURER");
  const [roleAddress, setRoleAddress] = useState("");

  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const grant = async () => {
    if (!isAddress(roleAddress)) return;
    const ok = await admin.submit("Grant role", (v) => v.grantRole(roleKey, roleAddress));
    if (ok) setRoleAddress("");
  };

  const revoke = async () => {
    if (!isAddress(roleAddress)) return;
    const ok = await admin.submit("Revoke role", (v) => v.revokeRole(roleKey, roleAddress));
    if (ok) setRoleAddress("");
  };

  return (
    <Panel
      title="Access control"
      description="Grants require DEFAULT_ADMIN_ROLE. Rotation: grant the new address, then revoke the old one."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Role">
          <select
            className="faucet-input"
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value as RoleName)}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Address">
          <input
            className="faucet-input mono"
            value={roleAddress}
            onChange={(e) => setRoleAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </Field>

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => void grant()}
            disabled={!canWrite || !isAddress(roleAddress)}
            className="flex-1 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Grant
          </button>
          <button
            type="button"
            onClick={() => void revoke()}
            disabled={!canWrite || !isAddress(roleAddress)}
            className="flex-1 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Revoke
          </button>
        </div>
      </div>
    </Panel>
  );
}

/** Recovers a token that was sent to the vault but never accepted. */
export function RescuePanel({ admin }: { admin: AdminState }) {
  const [token, setToken] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [error, setError] = useState<string | null>(null);

  const busy = admin.tx.kind === "signing" || admin.tx.kind === "pending";
  const canWrite = Boolean(admin.address) && !admin.wrongNetwork && !busy;

  const rescue = async () => {
    setError(null);

    let parsed: bigint;
    try {
      parsed = parseUnits(amount.trim() || "0", Number(decimals));
    } catch {
      setError("Amount is not a valid number for those decimals.");
      return;
    }

    if (parsed <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }

    await admin.submit("Rescue", (v) => v.rescue(token, to, parsed));
  };

  return (
    <Panel
      title="Rescue a stray token"
      description="Recovers a token sent here but never configured. Accepted tokens cannot be rescued — use Withdraw, so the accounting stays honest."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Field label="Stray token address">
            <input
              className="faucet-input mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label="Recipient">
          <input
            className="faucet-input mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </Field>

        <Field label="Amount">
          <input
            className="faucet-input mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
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
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void rescue()}
        disabled={!canWrite || !isAddress(token) || !isAddress(to) || amount.trim() === ""}
        className="mt-3 rounded-xl border border-ink-600 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:border-accent-500/50 hover:text-accent-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Rescue
      </button>
    </Panel>
  );
}
