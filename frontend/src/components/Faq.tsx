import { useState } from "react";

interface FaqItem {
  question: string;
  answer: string;
}

/**
 * FAQ copy.
 *
 * Deliberately network-specific: this faucet dispenses Hoodium RUNE and
 * ERC-20s, and the answers must not imply the tokens are BEP-20 or have value.
 * The claim of "ERC-20" is accurate — Hoodium's EVM is a standard Ethereum
 * JSON-RPC chain with 18-decimal native RUNE.
 */
const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What standard are these tokens issued in?",
    answer:
      "Native RUNE is the chain's gas token (18 decimals). ERC-20 assets distributed by this faucet are standard ERC-20 contracts deployed on Hoodium. Both are fully compatible with MetaMask, Rabby, Frame and any EVM tooling.",
  },
  {
    question: "Are there any rate limits?",
    answer:
      "Yes. Each wallet address can claim once per token per 24 hours, and the limit is also enforced on-chain by the faucet vault. Requests are additionally limited per IP address. If you hit a limit, the retry countdown tells you when you can claim again.",
  },
  {
    question: "Do these test tokens hold any financial value?",
    answer:
      "No. These tokens exist only for development and testing on Hoodium Devnet. They carry no financial value, are not redeemable, and the devnet is reset periodically. Never use test tokens in production or send real assets to devnet addresses.",
  },
  {
    question: "How do I add Hoodium Devnet to my wallet?",
    answer:
      "Add a custom EVM network with the RPC URL shown in this page's header, chain ID 6592, currency symbol RUNE and 18 decimals. The faucet sends tokens directly to the address you enter, so the wallet does not need to be connected.",
  },
];

/** Numbered accordion covering the operational questions users actually ask. */
export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section aria-labelledby="faq-heading" className="mt-12">
      <h2 id="faq-heading" className="mb-4 text-lg font-semibold text-slate-100">
        Frequently asked questions
      </h2>

      <div className="divide-y divide-ink-700 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900">
        {FAQ_ITEMS.map((item, index) => {
          const isOpen = openIndex === index;
          const number = (index + 1).toString().padStart(2, "0");

          return (
            <div key={item.question}>
              <button
                type="button"
                onClick={() => setOpenIndex(isOpen ? null : index)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-ink-850"
              >
                <span className="mono shrink-0 text-xs text-slate-600">{number}</span>
                <span className="flex-1 text-sm font-medium text-slate-100">{item.question}</span>
                <svg
                  className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${
                    isOpen ? "rotate-45" : ""
                  }`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                </svg>
              </button>

              {isOpen && (
                <div className="animate-fade-in px-5 pb-5 pl-[3.25rem]">
                  <p className="text-sm leading-relaxed text-slate-400">{item.answer}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
