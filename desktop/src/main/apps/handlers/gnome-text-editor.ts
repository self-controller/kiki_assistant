// Text Editor: shares its whole text over AT-SPI, so Kiki reads the lines around the highlight.
import { editor } from "../families.ts";

export default editor({
  id: "gnome-text-editor",
  name: "Text Editor",
  match: {
    ids: ["org.gnome.texteditor"],
    wmClasses: ["org.gnome.texteditor"],
    exes: ["gnome-text-editor"],
    atspiNames: ["gnome-text-editor", "org.gnome.texteditor"],
  },
  titleNames: ["Text Editor"],
});
