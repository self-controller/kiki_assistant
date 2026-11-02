// Alacritty. No text over AT-SPI; Kiki's GNOME helper (v11) tells it's Alacritty.
import { terminal } from "../families.ts";

export default terminal({
  id: "alacritty",
  name: "Alacritty",
  match: {
    ids: ["alacritty", "org.alacritty.alacritty"],
    wmClasses: ["alacritty"],
    exes: ["alacritty"],
    macNames: ["alacritty"],
  },
});
