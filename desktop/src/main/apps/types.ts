// What Kiki knows about particular apps: how to tell them apart, and what it does differently in each.
import type { Vicinity } from "../capture/common.ts";

export type AppKind = "browser" | "terminal" | "editor";

/** What Kiki knows about the window the hotkey was pressed in, to tell which app it is. Ids are lowercase. */
export interface AppIdentity {
  /** The desktop file's id without ".desktop", from Kiki's GNOME extension: "google-chrome", "org.gnome.ptyxis". */
  appId?: string;
  /** A flatpak's id, from the extension. */
  sandboxedId?: string;
  /** The app's id in its process's cgroup: flatpaks, D-Bus activated apps, apps GNOME started. */
  cgroupId?: string;
  wmClass?: string;
  /** The name of the app's program ("chrome", "ptyxis"), from the process AT-SPI has it under. */
  exe?: string;
  /** The app's name over AT-SPI ("zen", "ptyxis"). */
  atspiName?: string;
  /** The app's name on macOS ("google chrome", "iterm2"). */
  macName?: string;
  /** The window's own process, from the extension; for asking the app itself (kitty). */
  pid?: number;
}

/** The names an app goes by, all lowercase. Any one of them is enough. */
export interface AppMatch {
  /** Desktop file ids (without ".desktop"), flatpak ids and D-Bus names: compared with appId, sandboxedId, cgroupId. */
  ids?: string[];
  wmClasses?: string[];
  exes?: string[];
  atspiNames?: string[];
  macNames?: string[];
}

/** What an app's own reader adds to what Kiki read over AT-SPI. */
export interface AppExtras {
  /** The lines around the highlight (or what's on screen), trimmed like an AT-SPI terminal's or editor's. */
  vicinity?: Vicinity;
  /** What's highlighted, when the app itself says: "" means nothing is. */
  selection?: string;
}

export interface ReadContext {
  identity: AppIdentity;
  /** The window's title as the app set it (before `title`). */
  windowTitle?: string;
  /** What's highlighted so far (maybe the primary selection). */
  selection: string;
  /** Aborts once Kiki stops waiting (APP_READ_MS). */
  signal: AbortSignal;
}

export interface AppHandler {
  /** Stable and unique: "chrome". */
  id: string;
  /** The app's name, as Kiki shows and sends it. */
  name: string;
  kind: AppKind;
  match: AppMatch;
  /** The title to show and send, from the window's title and, in a browser, the page's own title. */
  title?(windowTitle: string, pageTitle?: string): string;
  /**
   * Reads what Kiki can't get over AT-SPI, once the popup is open. Runs only where the window shared no text and
   * Settings allows nearby text; Kiki stops waiting after APP_READ_MS. Undefined (or a throw) changes nothing.
   */
  read?(context: ReadContext): Promise<AppExtras | undefined>;
}
