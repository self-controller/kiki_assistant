// gedit: shares its whole text over AT-SPI, so Kiki reads the lines around the highlight.
import { editor } from "../families.ts";

export default editor({
  id: "gedit",
  name: "gedit",
  match: {
    ids: ["org.gnome.gedit"],
    wmClasses: ["gedit", "org.gnome.gedit"],
    exes: ["gedit"],
    atspiNames: ["gedit", "org.gnome.gedit"],
  },
  titleNames: ["gedit"],
});
