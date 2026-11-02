// Vivaldi (Chromium): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "vivaldi",
  name: "Vivaldi",
  match: {
    ids: ["vivaldi-stable", "vivaldi", "com.vivaldi.vivaldi"],
    wmClasses: ["vivaldi-stable"],
    exes: ["vivaldi-bin"],
    atspiNames: ["vivaldi"],
    macNames: ["vivaldi"],
  },
  titleNames: ["Vivaldi"],
});
