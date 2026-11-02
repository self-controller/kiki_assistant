// foot. No text over AT-SPI; Kiki's GNOME helper (v11) tells it's foot.
import { terminal } from "../families.ts";

export default terminal({
  id: "foot",
  name: "foot",
  match: {
    ids: ["foot", "footclient", "org.codeberg.dnkl.foot", "org.codeberg.dnkl.footclient"],
    wmClasses: ["foot", "footclient"],
    exes: ["foot", "footclient"],
  },
});
