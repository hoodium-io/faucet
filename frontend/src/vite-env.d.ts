/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the API base URL. Defaults to a relative `/api`. */
  readonly VITE_API_BASE_URL?: string;
  /** Dev-server proxy target for `/api`. */
  readonly VITE_BACKEND_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
