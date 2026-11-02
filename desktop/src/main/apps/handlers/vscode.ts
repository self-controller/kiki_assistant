// Visual Studio Code: nothing over AT-SPI. Kiki's GNOME helper (v11) names it and its title; the lines around the
// highlight come from the saved file when `window.title` shows its full path.
import { vscodeLike } from "../families.ts";

export default vscodeLike({
  id: "vscode",
  name: "Visual Studio Code",
  match: {
    ids: ["code", "code-url-handler", "com.visualstudio.code", "code-oss", "com.visualstudio.code-oss", "visual-studio-code"],
    wmClasses: ["code", "code-oss"],
    exes: ["code", "code-oss"],
    macNames: ["code", "visual studio code"],
  },
  titleNames: ["Visual Studio Code", "Code - OSS"],
});
