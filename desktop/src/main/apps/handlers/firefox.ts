// Firefox (Gecko): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "firefox",
  name: "Firefox",
  match: {
    ids: ["firefox", "firefox-esr", "org.mozilla.firefox"],
    wmClasses: ["firefox", "firefox-esr", "org.mozilla.firefox"],
    exes: ["firefox", "firefox-bin", "firefox-esr"],
    atspiNames: ["firefox"],
    macNames: ["firefox"],
  },
  titleNames: ["Mozilla Firefox", "Mozilla Firefox Private Browsing"],
});
