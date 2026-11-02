// Warp. No text over AT-SPI.
import { terminal } from "../families.ts";

export default terminal({
  id: "warp",
  name: "Warp",
  match: {
    ids: ["dev.warp.warp"],
    wmClasses: ["dev.warp.warp"],
    exes: ["warp"],
    macNames: ["warp"],
  },
});
