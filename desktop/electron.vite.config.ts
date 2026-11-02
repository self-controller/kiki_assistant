import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      // Bundle everything (all deps are devDependencies), so the packaged app needs no node_modules.
      externalizeDeps: false,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          popup: resolve(import.meta.dirname, "src/renderer/popup.html"),
          settings: resolve(import.meta.dirname, "src/renderer/settings.html"),
          browser: resolve(import.meta.dirname, "src/renderer/browser.html"),
        },
      },
    },
  },
});
