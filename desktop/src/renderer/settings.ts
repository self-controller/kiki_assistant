import type { Provider } from "@kiki/shared";
import { SERVICE_IDS, SERVICES, type ServiceId } from "../services.ts";
import type {
  AccountChoice,
  ActionResult,
  AgentProvider,
  AgentStatus,
  NearbyTextPolicy,
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
const hotkey = $<HTMLInputElement>("hotkey");
const nearbyText = $<HTMLSelectElement>("nearbyText");
const screenshot = $<HTMLSelectElement>("screenshot");
const cuBrowser = $<HTMLInputElement>("cuBrowser");
const cuWindows = $<HTMLInputElement>("cuWindows");
const cuCoordinates = $<HTMLInputElement>("cuCoordinates");
const cuAutoApprove = $<HTMLInputElement>("cuAutoApprove");
const launchAtLogin = $<HTMLInputElement>("launchAtLogin");
const personality = $<HTMLSelectElement>("personality");
const customPersonality = $<HTMLTextAreaElement>("customPersonality");
const saveStatus = $<HTMLSpanElement>("saveStatus");
/** The person's own API keys: the field, its Remove button and status, and what a saved key looks like. */
const KEY_FIELDS: Record<Provider, { input: HTMLInputElement; remove: HTMLButtonElement; status: HTMLElement; placeholder: string }> = {
  anthropic: { input: $("anthropicKey"), remove: $("removeAnthropicKey"), status: $("anthropicKeyStatus"), placeholder: "sk-ant-…" },
  google: { input: $("geminiKey"), remove: $("removeGeminiKey"), status: $("geminiKeyStatus"), placeholder: "AIza…" },
  openai: { input: $("openaiKey"), remove: $("removeOpenaiKey"), status: $("openaiKeyStatus"), placeholder: "sk-…" },
};

/** Claude Code and Codex: what they're called, and how to sign in. */
const AGENTS: Record<AgentProvider, { name: string; signIn: string }> = {
  anthropic: { name: "Claude Code", signIn: "run `claude` in a terminal and log in" },
  openai: { name: "Codex", signIn: "run `codex login` in a terminal" },
};

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

/** The radio buttons choosing how a provider's questions run. */
function accountRadios(provider: AgentProvider): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[name="${provider}Account"]`)];
}

/** What Settings says about the person's Claude Code or Codex. */
function agentLine(provider: AgentProvider, status: AgentStatus | null): { ok: boolean; message: string } {
  const { name, signIn } = AGENTS[provider];
  if (!status) return { ok: false, message: `Looking for ${name}…` };
  const version = status.version ? ` ${status.version}` : "";
  if (!status.path) return { ok: false, message: `Not found on this computer. Install ${name}, then ${signIn}.` };
  if (!status.signedIn) return { ok: false, message: `${name}${version} isn't signed in: ${signIn}.` };
  return { ok: true, message: `${name}${version}, signed in with ${status.account ?? "your account"}` };
}

/** The account choices as shown, so Save keeps them. */
let accounts: Record<AgentProvider, AccountChoice> = { anthropic: "agent", openai: "agent" };

function renderModels(view: SettingsView): void {
  accounts = view.accounts;
  for (const provider of ["anthropic", "openai"] as const) {
    for (const radio of accountRadios(provider)) radio.checked = radio.value === view.accounts[provider];
    show($(`${provider}AgentStatus`), agentLine(provider, view.agents[provider]));
  }
  for (const [provider, field] of Object.entries(KEY_FIELDS) as Array<[Provider, (typeof KEY_FIELDS)[Provider]]>) {
    const saved = view.providerKeys[provider];
    // Keep a key being typed when the window regains focus.
    if (document.activeElement !== field.input) field.input.value = "";
    field.input.placeholder = saved ? "Saved. Paste a new key to replace it." : field.placeholder;
    field.remove.hidden = !saved;
    const unused = provider !== "google" && view.accounts[provider] === "agent";
    if (saved && unused) show(field.status, { ok: true, message: `Saved, but not used while ${AGENTS[provider].name} is picked` });
    else if (saved) show(field.status, { ok: true, message: "Saved: its models are in the popup's model menu" });
    else {
      // Optional, so not a warning.
      field.status.textContent = "Not set";
      field.status.className = "hint";
    }
  }

  const list = $<HTMLUListElement>("customModels");
  list.replaceChildren(
    ...view.customModels.map((model) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = model.name;
      const where = document.createElement("span");
      where.className = "hint";
      where.textContent = model.service === "custom" ? new URL(model.baseUrl).host : SERVICES[model.service].name;
      name.title = `${model.model} at ${model.baseUrl}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const result = await api.removeModel(model.id);
        await refresh();
        show($("addStatus"), result);
      });
      item.append(name, where, remove);
      return item;
    }),
  );
}

function render(view: SettingsView): void {
  renderModels(view);
  hotkey.value = view.hotkey;
  nearbyText.value = view.nearbyText;
  // macOS sends only the selection: Kiki doesn't read the text around it there.
  $("nearbyTextRow").hidden = view.platform === "darwin";
  screenshot.value = view.screenshot;
  cuBrowser.checked = view.computerUse.browser;
  cuWindows.checked = view.computerUse.windows;
  cuCoordinates.checked = view.computerUse.coordinates;
  cuAutoApprove.checked = view.computerUse.autoApprove;
  // Other windows and clicks at coordinates go through the GNOME helper.
  $("cuWindowsRow").hidden = view.platform !== "linux";
  $("cuCoordinatesRow").hidden = view.platform !== "linux";
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
        off: "Switched off in GNOME: the popup opens in one spot and closes when you switch windows",
        missing: "Not installed: the popup opens in the middle of the screen",
      }[linux.extension],
    });
    $("installExtension").textContent = {
      missing: "Install GNOME helper",
      outdated: "Update GNOME helper",
      installed: "Reinstall",
      off: "Turn on GNOME helper",
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
    accounts,
    hotkey: hotkey.value,
    nearbyText: nearbyText.value as NearbyTextPolicy,
    screenshot: screenshot.value as ScreenshotPolicy,
    computerUse: { browser: cuBrowser.checked, windows: cuWindows.checked, coordinates: cuCoordinates.checked, autoApprove: cuAutoApprove.checked },
    launchAtLogin: launchAtLogin.checked,
    personality: personality.value as PersonalityChoice,
    customPersonality: customPersonality.value,
  };
  for (const [provider, field] of Object.entries(KEY_FIELDS) as Array<[Provider, (typeof KEY_FIELDS)[Provider]]>) {
    if (field.input.value.trim()) update.providerKeys = { ...update.providerKeys, [provider]: field.input.value };
  }
  return update;
}

/** When Settings last asked for its view; each view runs several processes on Linux. */
let refreshedAt = 0;

async function refresh(): Promise<void> {
  refreshedAt = Date.now();
  render(await api.get());
}

async function save(): Promise<ActionResult> {
  const update = collect();
  // A new key is checked with its provider first, which takes a moment.
  if (update.providerKeys) {
    saveStatus.textContent = "Checking your key…";
    saveStatus.className = "hint";
  }
  const result = await api.save(update);
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

// Picking Claude Code or the key (Codex or the key) applies right away.
for (const provider of ["anthropic", "openai"] as const) {
  for (const radio of accountRadios(provider)) {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const result = await api.save({ accounts: { [provider]: radio.value as AccountChoice } });
      await refresh();
      if (!result.ok) show(KEY_FIELDS[provider].status, result);
    });
  }
}

$("checkAgents").addEventListener("click", async () => {
  const status = $("agentsStatus");
  status.textContent = "Checking…";
  status.className = "hint";
  try {
    await api.checkAgents();
    status.textContent = "";
  } catch {
    show(status, { ok: false, message: "Kiki couldn't check." });
  }
  await refresh();
});

// ---------- Adding a model from another service, or a local one ----------

const newService = $<HTMLSelectElement>("newService");
const newUrl = $<HTMLInputElement>("newUrl");
const newKey = $<HTMLInputElement>("newKey");
const newModel = $<HTMLInputElement>("newModel");
const newName = $<HTMLInputElement>("newName");

for (const id of SERVICE_IDS) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = SERVICES[id].local ? `${SERVICES[id].name} (on this computer)` : SERVICES[id].name;
  newService.append(option);
}

/** Fills the form in for the service picked: its address, and whether it takes a key. */
function showService(): void {
  const service = SERVICES[newService.value as ServiceId];
  newUrl.value = service.baseUrl;
  $("newUrlRow").hidden = service.baseUrl !== "";
  $("newKeyRow").hidden = service.local;
  newKey.value = "";
  $("modelOptions").replaceChildren();
  $("loadStatus").textContent = "";
  const hint = $("keyHint");
  hint.replaceChildren();
  if ("keyUrl" in service) {
    const link = document.createElement("a");
    link.href = service.keyUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `Get a ${service.name} key`;
    hint.append(link, ". It stays on this computer and goes only to them.");
  } else if (service.local) {
    hint.textContent = `Start ${service.name} and load a model in it first.`;
  }
}

newService.addEventListener("change", showService);
showService();

$("loadModels").addEventListener("click", async () => {
  const status = $("loadStatus");
  status.textContent = "Loading…";
  status.className = "hint";
  const result = await api.listModels(newService.value as ServiceId, newUrl.value, newKey.value || undefined);
  if (!result.ok) return show(status, result);
  const options = result.models.map((model) => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  });
  $("modelOptions").replaceChildren(...options);
  show(status, { ok: true, message: result.models.length ? `${result.models.length} models: pick one below` : "No models yet" });
  if (!newModel.value && result.models.length === 1) newModel.value = result.models[0]!;
  newModel.focus();
});

$("addModelButton").addEventListener("click", async () => {
  const result = await api.addModel({
    service: newService.value as ServiceId,
    baseUrl: newUrl.value,
    model: newModel.value,
    name: newName.value,
    ...(newKey.value.trim() ? { key: newKey.value } : {}),
  });
  if (result.ok) {
    newModel.value = "";
    newName.value = "";
    showService();
    await refresh();
  }
  show($("addStatus"), result);
});

// Enter in the add form adds nothing by accident: it isn't the settings form's Save.
$("addModel").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
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

for (const [provider, field] of Object.entries(KEY_FIELDS) as Array<[Provider, (typeof KEY_FIELDS)[Provider]]>) {
  field.remove.addEventListener("click", async () => {
    const result = await api.save({ providerKeys: { [provider]: null } });
    await refresh();
    show(field.status, result.ok ? { ok: true, message: "Removed" } : result);
  });
}

$("quit").addEventListener("click", () => api.quit());

// Back from a browser tab or a dialog: things may have changed, unless the view is from a moment ago.
window.addEventListener("focus", () => {
  if (Date.now() - refreshedAt > 2_000) void refresh();
});
void refresh();
// Claude Code or Codex may have been installed or signed in since Kiki last looked.
void api.checkAgents().then(refresh, () => {});
