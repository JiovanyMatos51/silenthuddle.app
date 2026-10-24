/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_API_BASE?: string;
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
