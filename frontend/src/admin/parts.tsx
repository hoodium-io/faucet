import type { ReactNode } from "react";

/** Panel wrapper used by every admin section. */
export function Panel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Labelled field wrapper. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="faucet-label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

/** Read-only key/value row. */
export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="mono text-right text-xs text-slate-200">{value}</span>
    </div>
  );
}

/** Whether the connected address holds a role. */
export function RoleBadge({ name, held }: { name: string; held: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        held
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : "border-ink-700 bg-ink-850 text-slate-500"
      }`}
      title={held ? `${name}: granted` : `${name}: not granted`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${held ? "bg-emerald-400" : "bg-slate-600"}`}
        aria-hidden="true"
      />
      {name.replace("_ROLE", "")}
    </span>
  );
}

/** Transaction lifecycle banner. */
export function TxBanner({
  state,
  onDismiss,
}: {
  state: { kind: string; hash?: string; message?: string };
  onDismiss: () => void;
}) {
  if (state.kind === "idle") return null;

  if (state.kind === "signing") {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
        Confirm the transaction in your wallet…
      </div>
    );
  }

  if (state.kind === "pending") {
    return (
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
        Submitted — waiting for confirmation.
        <span className="mono mt-1 block break-all text-[11px] text-sky-300/70">{state.hash}</span>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div
        role="status"
        className="flex items-start justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200"
      >
        <span>
          Confirmed.
          <span className="mono mt-1 block break-all text-[11px] text-emerald-300/70">
            {state.hash}
          </span>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-emerald-300/60 hover:text-emerald-200"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-200"
    >
      <span>{state.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-red-300/60 hover:text-red-200"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
