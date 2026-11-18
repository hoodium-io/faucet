import { useEffect, useRef } from "react";

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "dark" | "light" | "auto";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    grecaptcha?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => number;
      reset: (widgetId?: number) => void;
      getResponse: (widgetId?: number) => string;
    };
  }
}

interface CaptchaWidgetProps {
  provider: "turnstile" | "recaptcha";
  siteKey: string;
  /** Called with the token when solved, and with "" when it expires/errors. */
  onToken: (token: string) => void;
}

const SCRIPT_SRC: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  recaptcha: "https://www.google.com/recaptcha/api.js?render=explicit",
};

/**
 * CAPTCHA widget for Turnstile or reCAPTCHA v2 (checkbox).
 *
 * The backend verifies the secret server-side; this component only produces the
 * token. Without it, a CAPTCHA-enabled backend rejects every claim, which is why
 * `ClaimCard` refuses to submit while `disabled` is true.
 *
 * Loads the provider script once (explicit render mode, so no auto-scanning of
 * the DOM), renders into a ref'd element, and re-renders if the provider changes.
 */
export function CaptchaWidget({ provider, siteKey, onToken }: CaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | number | null>(null);
  const onTokenRef = useRef(onToken);

  // Keep the latest callback without forcing the widget to re-render.
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;

    const render = () => {
      if (cancelled || !containerRef.current) return;

      const options: TurnstileRenderOptions = {
        sitekey: siteKey,
        theme: "dark",
        callback: (token: string) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(""),
        "error-callback": () => onTokenRef.current(""),
      };

      if (provider === "turnstile") {
        if (!window.turnstile) return;
        widgetId.current = window.turnstile.render(containerRef.current, options);
      } else {
        if (!window.grecaptcha?.render) return;
        widgetId.current = window.grecaptcha.render(containerRef.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(""),
        });
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="${SCRIPT_SRC[provider]?.split("?")[0]}"]`,
    );

    if (existing) {
      // Script tag already present; the global may still be initialising.
      if (provider === "turnstile" ? window.turnstile : window.grecaptcha) {
        render();
      } else {
        existing.addEventListener("load", render, { once: true });
      }
    } else {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC[provider];
      script.async = true;
      script.defer = true;
      script.addEventListener("load", render, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;

      // Remove the widget so a re-mount does not stack duplicates.
      if (widgetId.current !== null) {
        try {
          if (provider === "turnstile") {
            window.turnstile?.remove(widgetId.current as string);
          }
        } catch {
          // Provider may already have torn down the frame; nothing to do.
        }
        widgetId.current = null;
      }

      onTokenRef.current("");
    };
  }, [provider, siteKey]);

  return <div ref={containerRef} className="min-h-[65px]" aria-label="CAPTCHA verification" />;
}
