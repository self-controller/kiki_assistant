/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Default server address baked into builds (set in desktop/.env). */
  readonly MAIN_VITE_KIKI_SERVER_URL?: string;
  /** Your Google Cloud "Desktop app" OAuth client, for the Google connectors (set in desktop/.env). */
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string;
  /** Google issues desktop clients a secret, which isn't really secret in an app people install. */
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string;
}
