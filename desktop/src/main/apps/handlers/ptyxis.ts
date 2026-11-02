// Ptyxis. VTE: what's on screen over AT-SPI.
import { terminal } from "../families.ts";

export default terminal({
  id: "ptyxis",
  name: "Ptyxis",
  match: {
    ids: ["org.gnome.ptyxis", "app.devsuite.ptyxis"],
    wmClasses: ["org.gnome.ptyxis"],
    exes: ["ptyxis"],
    atspiNames: ["ptyxis"],
  },
});
