/** Shortens an address to `0x1234…abcd` for display. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (!address) return "";
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Formats a decimal string for display, trimming trailing zeros. */
export function formatAmount(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  // Large faucet amounts read better with thousands separators and no noise.
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

/** Formats a countdown in seconds as `HH:MM:SS` (or `MM:SS` under an hour). */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** Human-readable cooldown, e.g. "24 hours" or "30 minutes". */
export function describeCooldown(seconds: number): string {
  if (seconds <= 0) return "no cooldown";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Structural EVM address check, mirroring the server-side rule. */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
