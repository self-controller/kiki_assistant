// Works out which app a window belongs to, from Kiki's GNOME extension, AT-SPI and the app's process.
import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import type { ShellApp } from "../gnomeShell.ts";
import type { AppIdentity } from "./types.ts";

/** Programs that stand between an app and AT-SPI: a flatpak's D-Bus proxy has its pid, not the app. */
const NOT_THE_APP = new Set(["xdg-dbus-proxy", "bwrap", "flatpak-session-helper"]);

/** "google-chrome" from "Google-Chrome.desktop": lowercase, without the desktop file's extension. */
export function normalizeId(id: string | undefined | null): string | undefined {
  const clean = id?.trim().toLowerCase().replace(/\.desktop$/, "");
  return clean || undefined;
}

/** systemd's escaping in unit names: "google\x2dchrome" is "google-chrome". */
function unescapeUnit(name: string): string {
  return name.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The app id in a process's /proc/<pid>/cgroup, where systemd puts each app GNOME starts in its own unit:
 * "app-flatpak-app.zen_browser.zen-41365.scope", "dbus-:1.2-org.gnome.Ptyxis@6.service",
 * "app-gnome-google\x2dchrome-1234.scope". Undefined for anything else (a program started in a terminal).
 */
export function appIdFromCgroup(cgroup: string): string | undefined {
  const line = cgroup.split("\n").find((entry) => entry.startsWith("0::")) ?? cgroup.split("\n")[0] ?? "";
  const unit = line.slice(line.lastIndexOf("/") + 1).trim();
  const match =
    /^app-flatpak-(.+)-\d+\.scope$/.exec(unit) ??
    /^app-gnome-(.+)-\d+\.scope$/.exec(unit) ??
    /^dbus-:[\d.]+-(.+)@\d+\.service$/.exec(unit) ??
    /^app-(?:gnome-)?(.+?)@[^@]*\.service$/.exec(unit) ??
    /^app-(.+)-\d+\.scope$/.exec(unit);
  return normalizeId(match?.[1] && unescapeUnit(match[1]));
}

/** What the app's process says about it: its cgroup's app id and its program's name. Fast: two /proc reads. */
export async function procIdentity(pid: number): Promise<Pick<AppIdentity, "cgroupId" | "exe">> {
  const [cgroup, exe] = await Promise.all([
    readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => ""),
    readlink(`/proc/${pid}/exe`).catch(() => ""),
  ]);
  const program = exe ? basename(exe.replace(/ \(deleted\)$/, "")).toLowerCase() : "";
  const cgroupId = appIdFromCgroup(cgroup);
  return {
    ...(cgroupId ? { cgroupId } : {}),
    ...(program && !NOT_THE_APP.has(program) ? { exe: program } : {}),
  };
}

/** Everything Kiki knows on Linux about the window the hotkey was pressed in. */
export function linuxIdentity(
  atspi: { appName?: string | null },
  shell: ShellApp | null,
  proc: Pick<AppIdentity, "cgroupId" | "exe">,
): AppIdentity {
  const identity: AppIdentity = {
    // GNOME names a window no desktop file claims "window:12".
    appId: shell?.id.startsWith("window:") ? undefined : normalizeId(shell?.id),
    sandboxedId: normalizeId(shell?.sandboxedId),
    wmClass: normalizeId(shell?.wmClass),
    atspiName: normalizeId(atspi.appName),
    ...proc,
    ...(shell?.pid ? { pid: shell.pid } : {}),
  };
  return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)) as AppIdentity;
}
