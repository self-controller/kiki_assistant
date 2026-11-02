// Brave (Chromium): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "brave",
  name: "Brave",
  match: {
    ids: ["brave-browser", "com.brave.browser"],
    wmClasses: ["brave-browser"],
    exes: ["brave"],
    atspiNames: ["brave", "brave browser", "brave-browser"],
    macNames: ["brave browser"],
  },
  titleNames: ["Brave"],
});
