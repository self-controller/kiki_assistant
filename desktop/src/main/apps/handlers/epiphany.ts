// GNOME Web (WebKitGTK): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "epiphany",
  name: "GNOME Web",
  match: {
    ids: ["org.gnome.epiphany"],
    wmClasses: ["org.gnome.epiphany", "epiphany"],
    exes: ["epiphany"],
    atspiNames: ["epiphany", "org.gnome.epiphany"],
  },
  titleNames: ["Web"],
});
