// Microsoft Edge (Chromium): pages over AT-SPI, once "Read text in browsers" is on.
import { browser } from "../families.ts";

export default browser({
  id: "edge",
  name: "Microsoft Edge",
  match: {
    ids: ["microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev", "com.microsoft.edge"],
    wmClasses: ["microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev"],
    exes: ["msedge"],
    atspiNames: ["microsoft edge", "microsoft-edge"],
    macNames: ["microsoft edge"],
  },
  titleNames: ["Microsoft Edge"],
});
