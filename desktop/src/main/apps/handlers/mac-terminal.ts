// Terminal. macOS's Terminal.
import { terminal } from "../families.ts";

export default terminal({
  id: "mac-terminal",
  name: "Terminal",
  match: {
    macNames: ["terminal"],
  },
});
