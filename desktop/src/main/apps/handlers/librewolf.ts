// LibreWolf (Gecko): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "librewolf",
  name: "LibreWolf",
  match: {
    ids: ["librewolf", "io.gitlab.librewolf-community"],
    wmClasses: ["librewolf", "io.gitlab.librewolf-community"],
    exes: ["librewolf", "librewolf-bin"],
    atspiNames: ["librewolf"],
    macNames: ["librewolf"],
  },
  titleNames: ["LibreWolf", "LibreWolf Private Browsing"],
});
