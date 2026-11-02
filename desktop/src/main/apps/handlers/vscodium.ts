// VSCodium: nothing over AT-SPI. Kiki's GNOME helper (v11) names it and its title; the lines around the
// highlight come from the saved file when `window.title` shows its full path.
import { vscodeLike } from "../families.ts";

export default vscodeLike({
  id: "vscodium",
  name: "VSCodium",
  match: {
    ids: ["codium", "codium-url-handler", "com.vscodium.codium", "vscodium"],
    wmClasses: ["vscodium", "codium"],
    exes: ["codium"],
    macNames: ["vscodium"],
  },
  titleNames: ["VSCodium"],
});
