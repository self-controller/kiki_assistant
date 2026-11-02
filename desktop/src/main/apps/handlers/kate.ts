// Kate: shares its whole text over AT-SPI, so Kiki reads the lines around the highlight.
import { editor } from "../families.ts";

export default editor({
  id: "kate",
  name: "Kate",
  match: {
    ids: ["org.kde.kate", "org.kde.kwrite"],
    wmClasses: ["kate", "kwrite", "org.kde.kate", "org.kde.kwrite"],
    exes: ["kate", "kwrite"],
    atspiNames: ["kate", "kwrite"],
  },
  titleNames: ["Kate", "KWrite"],
});
