/// <reference types="vite/client" />
import type { KikiBridge } from "../shared-types.ts";

declare global {
  interface Window {
    kiki: KikiBridge;
  }
}

export {};
