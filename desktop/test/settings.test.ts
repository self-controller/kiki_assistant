import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings live in Electron's userData folder: here, a fresh folder per test.
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.dir },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "basic_text" },
}));

/** settings.ts as a fresh process would load it (it keeps what it read). */
async function load() {
  vi.resetModules();
  return import("../src/main/settings.ts");
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), "kiki-settings-"));
});

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("computer control settings", () => {
  it("act without asking is off until the person turns it on, and the rest is on", async () => {
    const { getSettings } = await load();
    expect(getSettings().computerUse).toEqual({ browser: true, windows: true, coordinates: true, autoApprove: false });
  });

  it("keep act without asking when it's turned on, without touching the others", async () => {
    const first = await load();
    first.saveSettings({ computerUse: { autoApprove: true } });
    const { getSettings } = await load();
    expect(getSettings().computerUse).toEqual({ browser: true, windows: true, coordinates: true, autoApprove: true });
  });

  it("read a settings file from before the setting as off", async () => {
    writeFileSync(join(state.dir, "settings.json"), JSON.stringify({ computerUse: { browser: false, windows: true, coordinates: true } }));
    const { getSettings } = await load();
    expect(getSettings().computerUse).toEqual({ browser: false, windows: true, coordinates: true, autoApprove: false });
  });
});
