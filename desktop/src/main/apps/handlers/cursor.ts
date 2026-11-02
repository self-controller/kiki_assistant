// Cursor: nothing over AT-SPI. Kiki's GNOME helper (v11) names it and its title; the lines around the
// highlight come from the saved file when `window.title` shows its full path.
import { vscodeLike } from "../families.ts";

export default vscodeLike({
  id: "cursor",
  name: "Cursor",
  match: {
    ids: ["cursor", "cursor-url-handler", "co.anysphere.cursor"],
    wmClasses: ["cursor"],
    exes: ["cursor"],
    macNames: ["cursor"],
  },
  titleNames: ["Cursor"],
});
