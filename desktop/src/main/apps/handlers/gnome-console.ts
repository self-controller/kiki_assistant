// Console. VTE: what's on screen over AT-SPI.
import { terminal } from "../families.ts";

export default terminal({
  id: "gnome-console",
  name: "Console",
  match: {
    ids: ["org.gnome.console"],
    wmClasses: ["org.gnome.console", "kgx"],
    exes: ["kgx"],
    atspiNames: ["kgx", "org.gnome.console"],
  },
});
