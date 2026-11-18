import { useEffect, useRef, useState } from "react";
import type { TokenInfo } from "@/lib/types";
import { formatAmount } from "@/lib/format";

interface TokenSelectProps {
  tokens: TokenInfo[];
  selected: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  disabled?: boolean;
}

/**
 * Custom combobox for choosing which token to claim.
 *
 * Styled as a full-width selectable row that opens a menu showing each token's
 * symbol, name and fixed dispense amount — the pattern from the reference
 * faucet. Built on plain buttons rather than a `<select>` so each option can
 * show two lines and a disabled state, which a native select cannot.
 */
export function TokenSelect({ tokens, selected, onSelect, disabled }: TokenSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape, so the menu never traps the user.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Every token is listed, including disabled and out-of-stock ones, so the user
  // can see what the faucet supports rather than wondering why it is missing.
  // Unavailable entries render disabled with the reason inline.
  const selectable = tokens;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || tokens.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select token to claim"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-ink-700
                   bg-ink-800 px-4 py-3.5 text-left transition-colors
                   hover:border-ink-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {selected ? (
          <span className="flex min-w-0 flex-col">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-slate-100">{selected.symbol}</span>
              {selected.isNative && (
                <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-400">
                  Gas
                </span>
              )}
            </span>
            <span className="truncate text-xs text-slate-500">{selected.name}</span>
          </span>
        ) : (
          <span className="text-sm text-slate-500">Select a token</span>
        )}

        <span className="flex shrink-0 items-center gap-3">
          {selected && (
            <span className="mono text-sm font-semibold text-slate-200">
              {formatAmount(selected.drip)} {selected.symbol}
            </span>
          )}
          <svg
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Available tokens"
          className="absolute z-20 mt-2 max-h-72 w-full animate-fade-in overflow-y-auto
                     rounded-xl border border-ink-700 bg-ink-850 p-1.5 shadow-card"
        >
          {selectable.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-slate-500">
              No tokens are currently configured.
            </li>
          )}

          {selectable.map((token) => {
            const unavailable = !token.enabled || token.lowInventory;
            const isSelected = selected?.address === token.address;

            return (
              <li key={token.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={unavailable}
                  onClick={() => {
                    onSelect(token);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left
                              transition-colors disabled:cursor-not-allowed disabled:opacity-50
                              ${isSelected ? "bg-ink-700" : "hover:bg-ink-800"}`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-slate-100">{token.symbol}</span>
                    <span className="truncate text-xs text-slate-500">
                      {token.name}
                      {!token.enabled && " · disabled"}
                      {token.enabled && token.lowInventory && " · out of stock"}
                    </span>
                  </span>
                  <span className="mono shrink-0 text-sm text-slate-300">
                    {formatAmount(token.drip)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
