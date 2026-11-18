import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config, matching the conventions used in `hoodium-io`
 * (port 3000, 0.0.0.0 bind, `@` alias to src).
 *
 * The dev server proxies `/api` to the backend so the browser only ever talks to
 * one origin. That keeps CORS simple in development and mirrors production,
 * where nginx serves the static build and proxies `/api` to the API container.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    root: ".",
    publicDir: "public",
    server: {
      port: 3001,
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
