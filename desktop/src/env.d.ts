/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Default server address baked into builds (set in desktop/.env). */
  readonly MAIN_VITE_KIKI_SERVER_URL?: string;
}
