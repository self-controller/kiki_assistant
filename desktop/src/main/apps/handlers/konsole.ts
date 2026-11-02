// Konsole. Qt: what it shares over AT-SPI, if anything.
import { terminal } from "../families.ts";

export default terminal({
  id: "konsole",
  name: "Konsole",
  match: {
    ids: ["org.kde.konsole"],
    wmClasses: ["konsole", "org.kde.konsole"],
    exes: ["konsole"],
    atspiNames: ["konsole"],
  },
});
