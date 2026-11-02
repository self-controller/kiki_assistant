// Chromium (Chromium): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "chromium",
  name: "Chromium",
  match: {
    ids: ["chromium", "chromium-browser", "org.chromium.chromium"],
    wmClasses: ["chromium", "chromium-browser"],
    exes: ["chromium", "chromium-browser"],
    atspiNames: ["chromium", "chromium-browser"],
    macNames: ["chromium"],
  },
  titleNames: ["Chromium"],
});
