// Google Chrome (Chromium): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "chrome",
  name: "Google Chrome",
  match: {
    ids: ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "com.google.chrome"],
    wmClasses: ["google-chrome", "google-chrome-beta", "google-chrome-unstable"],
    exes: ["chrome"],
    atspiNames: ["google chrome", "google-chrome"],
    macNames: ["google chrome"],
  },
  titleNames: ["Google Chrome"],
});
