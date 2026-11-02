// WezTerm: nothing over AT-SPI, but its own CLI prints the focused pane's screen, with no setup. Kiki's GNOME
// helper (v11) tells it's WezTerm.
import { execText, screenVicinity, terminal, type Exec } from "../families.ts";
import type { AppExtras, ReadContext } from "../types.ts";

const FLATPAK_ID = "org.wezfurlong.wezterm";
/** Lines of scrollback above the screen: about what Kiki keeps above a terminal's cursor. */
const SCROLLBACK_LINES = 80;

/** The screen of WezTerm's most recently focused pane (the one the hotkey was pressed in), from `wezterm cli get-text`. */
export async function readWezterm(context: ReadContext, exec: Exec = execText): Promise<AppExtras | undefined> {
  const args = ["cli", "get-text", "--start-line", `-${SCROLLBACK_LINES}`];
  const flatpak = context.identity.sandboxedId === FLATPAK_ID;
  const [file, argv] = flatpak ? ["flatpak", ["run", "--command=wezterm", FLATPAK_ID, ...args]] : ["wezterm", args];
  // Started from a WezTerm pane, Kiki has that pane's id, and the CLI would read that pane instead.
  const { WEZTERM_PANE: _pane, ...env } = process.env;
  const screen = await exec(file, argv, { signal: context.signal, env });
  return screen.trim() ? { vicinity: screenVicinity(screen, context.selection) } : undefined;
}

export default terminal({
  id: "wezterm",
  name: "WezTerm",
  match: {
    ids: ["org.wezfurlong.wezterm"],
    wmClasses: ["org.wezfurlong.wezterm"],
    exes: ["wezterm-gui"],
    macNames: ["wezterm"],
  },
  read: (context) => readWezterm(context),
});
