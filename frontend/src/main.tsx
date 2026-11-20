import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdminPage } from "./admin/AdminPage";
import "./index.css";

/**
 * Two-page hash router.
 *
 * A router library would be overkill for two routes, and hash routing avoids any
 * server-side rewrite rules: nginx already serves `index.html` for unknown paths,
 * so `#/admin` needs no extra config. It also keeps the admin console at a stable,
 * unguessable-by-accident URL without a `/admin` directory that a static host
 * might 404 on.
 */
function Router() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // `#/admin` and `#/admin/` both route to the console.
  const isAdmin = hash.replace(/\/+$/, "") === "#/admin";

  return isAdmin ? <AdminPage /> : <App />;
}

const container = document.getElementById("root");
if (!container) {
  throw new Error('Root element "#root" not found in index.html.');
}

createRoot(container).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
