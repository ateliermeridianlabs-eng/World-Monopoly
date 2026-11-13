/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional TURN server URLs for online play, comma-separated (e.g. `turn:turn.example.com:3478`). Public once built. */
  readonly VITE_TURN_URLS?: string;
  /** Optional TURN username. Public once built. */
  readonly VITE_TURN_USERNAME?: string;
  /** Optional TURN credential. Public once built. */
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
