interface Channel {
  name: string;
  description: string;
  href: string | null;
  /** Shown as a muted "coming soon" box when no href exists yet. */
  available: boolean;
}

/**
 * Secondary distribution channels.
 *
 * Hoodium has no third-party faucet or infrastructure partners yet, so these are
 * honest placeholders rather than dead links: anything without a real URL is
 * rendered as "coming soon" instead of a button that goes nowhere. Update
 * `href` and flip `available` when a partner or docs page exists.
 */
const CHANNELS: Channel[] = [
  {
    name: "Official docs",
    description: "Network parameters, wallet setup and validator guides.",
    href: null,
    available: false,
  },
  {
    name: "Discord",
    description: "Request extra Devnet tokens from the team.",
    href: null,
    available: false,
  },
  {
    name: "RPC providers",
    description: "Public Devnet RPC endpoints for your tooling.",
    href: null,
    available: false,
  },
];

/** Grid of alternative ways to obtain test tokens. */
export function Channels() {
  return (
    <section aria-labelledby="channels-heading" className="mt-12">
      <h2 id="channels-heading" className="mb-1 text-lg font-semibold text-slate-100">
        Get test tokens from other channels
      </h2>
      <p className="mb-4 text-sm text-slate-500">
        Each address is limited to one claim per token per day, so these are useful when you need
        more.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {CHANNELS.map((channel) => {
          const body = (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-100">{channel.name}</span>
                {!channel.available && (
                  <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Soon
                  </span>
                )}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                {channel.description}
              </span>
            </>
          );

          const base =
            "block rounded-xl border border-ink-700 bg-ink-900 p-4 transition-colors";

          return channel.available && channel.href ? (
            <a
              key={channel.name}
              href={channel.href}
              target="_blank"
              rel="noreferrer noopener"
              className={`${base} hover:border-accent-500/50 hover:bg-ink-850`}
            >
              {body}
            </a>
          ) : (
            <div key={channel.name} className={`${base} opacity-70`} aria-disabled="true">
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}
