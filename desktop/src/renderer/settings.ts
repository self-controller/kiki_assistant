import type {
  ActionResult,
  PersonalityChoice,
  ScreenshotPolicy,
  SettingsUpdate,
  SettingsView,
} from "../shared-types.ts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import "./settings.css";

const api = window.kiki.settings;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const serverUrl = $<HTMLInputElement>("serverUrl");
const accessCode = $<HTMLInputElement>("accessCode");
const hotkey = $<HTMLInputElement>("hotkey");
const screenshot = $<HTMLSelectElement>("screenshot");
const launchAtLogin = $<HTMLInputElement>("launchAtLogin");
const personality = $<HTMLSelectElement>("personality");
const customPersonality = $<HTMLTextAreaElement>("customPersonality");
const saveStatus = $<HTMLSpanElement>("saveStatus");
const testResult = $<HTMLSpanElement>("testResult");

function show(target: HTMLElement, result: ActionResult | { ok: boolean; message?: string }): void {
  target.textContent = result.message ?? "";
  target.classList.toggle("warn", !result.ok);
  target.classList.toggle("ok", result.ok);
}

function setText(id: string, text: string | undefined): void {
  const node = $<HTMLElement>(id);
  node.textContent = text ?? "";
  node.hidden = !text;
}

function render(view: SettingsView): void {
  serverUrl.value = view.serverUrl;
  accessCode.value = "";
  accessCode.placeholder = view.hasAccessCode ? "Saved. Paste a new code to replace it." : "kiki_…";
  hotkey.value = view.hotkey;
  screenshot.value = view.screenshot;
  launchAtLogin.checked = view.launchAtLogin;
  personality.value = view.personality;
  // Keep an unsaved prompt when the window regains focus.
  if (document.activeElement !== customPersonality) customPersonality.value = view.customPersonality;
  showCustom();
  setText("storageWarning", view.storageWarning);
  setText("hotkeyError", view.hotkeyError);

  const linux = view.linux;
  $("linuxShortcut").hidden = !linux?.wayland;
  $("linuxPopup").hidden = !(linux?.wayland && linux.gnome);
  $("linuxA11y").hidden = !linux;
  if (linux) {
    $("shortcutCommand").textContent = linux.shortcutCommand;
    show($("shortcutStatus"), {
      ok: linux.shortcutInstalled,
      message: linux.shortcutInstalled
        ? `Installed (${linux.shortcutBinding})`
        : linux.gnome
          ? "Not installed yet"
          : "GNOME shortcuts aren't available here",
    });
    show($("extensionStatus"), {
      ok: linux.extension === "active",
      message: {
        active: "On: the popup opens at the pointer",
        outdated: "On, but this Kiki has a newer version: update it, then log out and back in",
        installed: "Installed. Log out and back in to finish.",
        missing: "Not installed: the popup opens in the middle of the screen",
      }[linux.extension],
    });
    $("installExtension").textContent = {
      missing: "Install GNOME helper",
      outdated: "Update GNOME helper",
      installed: "Reinstall",
      active: "Reinstall",
    }[linux.extension];
    show($("a11yStatus"), {
      ok: linux.accessibilityEnabled,
      message: linux.accessibilityEnabled ? "On" : "Off",
    });
    $<HTMLButtonElement>("enableA11y").disabled = linux.accessibilityEnabled;
    const problems = [
      linux.helperError
        ? "Kiki's accessibility helper can't run. Install PyGObject (python3-gobject) and AT-SPI (at-spi2-core)."
        : "",
      linux.clipboardTool ? "" : "Install wl-clipboard (Wayland) or xclip (X11) so Kiki can read highlighted text.",
    ].filter(Boolean);
    setText("linuxProblems", problems.join(" ") || undefined);
  }

  const google = view.google;
  googleConnected = google.connected;
  $("accounts").hidden = !google.available;
  $("google").textContent = google.connected ? "Disconnect" : "Connect Google";
  if (!googleBusy) {
    show($("googleStatus"), {
      ok: google.connected,
      message: google.connected ? `Connected${google.email ? ` as ${google.email}` : ""}` : "Not connected",
    });
  }

  const mac = view.mac;
  $("macPerms").hidden = !mac;
  if (mac) {
    const ready = mac.accessibility && mac.screen === "granted";
    show($("macStatus"), {
      ok: ready,
      message: `Accessibility: ${mac.accessibility ? "allowed" : "not allowed"} · Screen Recording: ${mac.screen === "granted" ? "allowed" : "not allowed"}`,
    });
  }
}

/** The prompt box shows only for "My own way…". */
function showCustom(): void {
  $("customWrap").hidden = personality.value !== "custom";
}

let googleConnected = false;
let googleBusy = false;

function collect(): SettingsUpdate {
  const update: SettingsUpdate = {
    serverUrl: serverUrl.value,
    hotkey: hotkey.value,
    screenshot: screenshot.value as ScreenshotPolicy,
    launchAtLogin: launchAtLogin.checked,
    personality: personality.value as PersonalityChoice,
    customPersonality: customPersonality.value,
  };
  if (accessCode.value.trim()) update.accessCode = accessCode.value;
  return update;
}

async function refresh(): Promise<void> {
  render(await api.get());
}

async function save(): Promise<ActionResult> {
  const result = await api.save(collect());
  show(saveStatus, result);
  if (result.ok) await refresh();
  return result;
}

personality.addEventListener("change", () => {
  showCustom();
  if (personality.value === "custom") customPersonality.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

$("test").addEventListener("click", async () => {
  testResult.textContent = "Checking…";
  testResult.className = "hint";
  const saved = await save();
  if (!saved.ok) {
    show(testResult, saved);
    return;
  }
  const result = await api.test();
  show(
    testResult,
    result.ok
      ? { ok: true, message: `Connected as ${result.me.name} · ${result.me.usedToday}/${result.me.dailyLimit} questions today` }
      : result,
  );
});

$("installShortcut").addEventListener("click", async () => {
  const saved = await api.save({ hotkey: hotkey.value });
  if (!saved.ok && saved.message !== undefined && !saved.message.startsWith("Saved")) {
    show($("shortcutStatus"), saved);
    return;
  }
  const result = await api.installShortcut();
  await refresh();
  show($("shortcutStatus"), result);
});

$("installExtension").addEventListener("click", async () => {
  const result = await api.installExtension();
  await refresh();
  show($("extensionStatus"), result);
});

$("enableA11y").addEventListener("click", async () => {
  const result = await api.enableAccessibility();
  await refresh();
  show($("a11yStatus"), result);
});

$("macPermissions").addEventListener("click", async () => {
  const result = await api.requestMacPermissions();
  show($("macStatus"), result);
});

$("google").addEventListener("click", async () => {
  if (googleBusy) return;
  googleBusy = true;
  const button = $<HTMLButtonElement>("google");
  button.disabled = true;
  const status = $("googleStatus");
  status.textContent = googleConnected ? "Disconnecting…" : "Finish signing in in your browser…";
  status.className = "hint";
  const result = googleConnected ? await api.disconnectGoogle() : await api.connectGoogle();
  googleBusy = false;
  button.disabled = false;
  await refresh();
  show(status, result);
});

$("quit").addEventListener("click", () => api.quit());

window.addEventListener("focus", () => void refresh());
void refresh();
