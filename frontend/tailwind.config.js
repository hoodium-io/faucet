/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Deep minimalist dark-mode scheme taken from the spec: near-black
        // surface, white typography, amber accents for interactive highlights.
        ink: {
          950: "#08090b", // page background, one step below the card
          900: "#0b0e11", // primary surface
          850: "#11151a", // raised surface
          800: "#171c23", // input / dropdown
          700: "#222933", // borders and dividers
          600: "#2f3845",
        },
        accent: {
          400: "#fcd34d",
          500: "#f5b93b", // primary amber
          600: "#e0a017",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 60px -20px rgba(0,0,0,0.8)",
      },
      animation: {
        "spin-slow": "spin 1s linear infinite",
        "fade-in": "fadeIn 0.2s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
