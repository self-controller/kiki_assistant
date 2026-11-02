// The list of past sessions that opens when Kiki (the mascot) is clicked, inside the chat box.
import type { HistoryItem } from "../shared-types.ts";
import { el, keepFocus } from "./dom.ts";
import { formatWhen, plural } from "./feed.ts";
import { icon } from "./icons.ts";

export interface HistoryHandlers {
  open(item: HistoryItem): void;
  clear(): void;
  /** Opens Kiki Settings. */
  settings(): void;
  /** Saves a session for good (or lets it go after a week); resolves false when that didn't work. */
  save(item: HistoryItem, saved: boolean): Promise<boolean>;
}

/** The bookmark next to a session: saved sessions stay; the others go a week after they were last used. */
function saveButton(item: HistoryItem, handlers: HistoryHandlers): HTMLButtonElement {
  const button = el("button", "history-save");
  button.type = "button";
  button.append(icon("bookmark", 14));
  const sync = () => {
    button.setAttribute("aria-pressed", String(item.saved));
    button.setAttribute("aria-label", item.saved ? "Saved chat" : "Save chat");
    button.title = item.saved ? "Saved. Click to unsave" : "Save this chat (unsaved chats are deleted after a week)";
  };
  keepFocus(button);
  button.addEventListener("click", () => {
    const saved = !item.saved;
    item.saved = saved;
    sync();
    void handlers.save(item, saved).then((ok) => {
      if (ok || item.saved !== saved) return;
      item.saved = !saved;
      sync();
    });
  });
  sync();
  return button;
}

/** The gear in the header: opens Settings. */
function settingsButton(handlers: HistoryHandlers): HTMLButtonElement {
  const button = el("button", "history-settings");
  button.type = "button";
  button.title = "Settings";
  button.setAttribute("aria-label", "Settings");
  button.append(icon("settings", 14));
  keepFocus(button);
  button.addEventListener("click", () => handlers.settings());
  return button;
}

/**
 * Fills `root` with a header (with Clear, which asks twice, and the Settings gear) and one row per
 * past session, each with its bookmark.
 */
export function renderHistory(root: HTMLElement, items: HistoryItem[], handlers: HistoryHandlers): void {
  const head = el("div", "history-head");
  const actions = el("span", "history-actions");
  head.append(el("span", "history-title", "Past sessions"), actions);
  if (items.length > 0) {
    const clear = el("button", "history-clear", "Clear");
    clear.type = "button";
    let disarm = 0;
    keepFocus(clear);
    clear.addEventListener("click", () => {
      if (clear.classList.contains("armed")) return handlers.clear();
      clear.classList.add("armed");
      clear.textContent = "Clear all?";
      window.clearTimeout(disarm);
      disarm = window.setTimeout(() => {
        clear.classList.remove("armed");
        clear.textContent = "Clear";
      }, 3000);
    });
    actions.append(clear);
  }
  actions.append(settingsButton(handlers));

  const list = el("div", "history-items");
  if (items.length === 0) list.append(el("p", "history-empty", "No past sessions yet."));
  const now = Date.now();
  items.forEach((item, index) => {
    const row = el("button", "history-item");
    row.type = "button";
    if (item.windowTitle) row.title = item.windowTitle;
    const line = el("span", "history-line");
    line.append(el("span", "history-item-title", item.title || "Untitled"));
    if (item.current) {
      row.setAttribute("aria-current", "true");
      line.append(el("span", "history-tag", "This chat"));
    }
    const meta = [item.appName, formatWhen(item.updatedAt, now), item.turns > 1 ? plural(item.turns, "question") : null];
    row.append(line, el("span", "history-item-meta", meta.filter(Boolean).join(" · ")));
    keepFocus(row);
    row.addEventListener("click", () => handlers.open(item));
    const wrap = el("div", "history-row");
    wrap.style.setProperty("--i", String(Math.min(index, 10)));
    wrap.append(row, saveButton(item, handlers));
    list.append(wrap);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...list.querySelectorAll<HTMLElement>(".history-item")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  });
  root.replaceChildren(head, list);
}
