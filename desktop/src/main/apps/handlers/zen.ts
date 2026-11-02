// Zen Browser (Gecko): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "zen",
  name: "Zen Browser",
  match: {
    ids: ["app.zen_browser.zen", "zen", "zen-browser"],
    wmClasses: ["zen", "zen-browser", "app.zen_browser.zen"],
    exes: ["zen", "zen-bin"],
    atspiNames: ["zen"],
    macNames: ["zen", "zen browser"],
  },
  titleNames: ["Zen Browser", "Zen Browser Private Browsing"],
});
