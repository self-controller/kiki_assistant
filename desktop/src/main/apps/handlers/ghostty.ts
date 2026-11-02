// Ghostty. No text over AT-SPI; Kiki's GNOME helper (v11) tells it's Ghostty.
import { terminal } from "../families.ts";

export default terminal({
  id: "ghostty",
  name: "Ghostty",
  match: {
    ids: ["com.mitchellh.ghostty"],
    wmClasses: ["com.mitchellh.ghostty", "ghostty"],
    exes: ["ghostty"],
    atspiNames: ["ghostty", "com.mitchellh.ghostty"],
    macNames: ["ghostty"],
  },
});
