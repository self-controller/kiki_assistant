// Tilix. VTE: what's on screen over AT-SPI.
import { terminal } from "../families.ts";

export default terminal({
  id: "tilix",
  name: "Tilix",
  match: {
    ids: ["com.gexperts.tilix"],
    wmClasses: ["tilix", "com.gexperts.tilix"],
    exes: ["tilix"],
    atspiNames: ["tilix"],
  },
});
