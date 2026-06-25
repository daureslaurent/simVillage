/// <reference types="vite/client" />

// Typed access to the env vars we inject at build time (see docker-compose.yml).
interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
