// GNOME Terminal. VTE: what's on screen over AT-SPI.
import { terminal } from "../families.ts";

export default terminal({
  id: "gnome-terminal",
  name: "GNOME Terminal",
  match: {
    ids: ["org.gnome.terminal"],
    wmClasses: ["gnome-terminal-server", "org.gnome.terminal"],
    exes: ["gnome-terminal-server"],
    atspiNames: ["gnome-terminal-server", "gnome-terminal"],
  },
});
