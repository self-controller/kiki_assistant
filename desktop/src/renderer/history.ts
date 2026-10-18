// The list of past sessions that opens when Kiki (the mascot) is clicked, inside the chat box.
import type { HistoryItem } from "../shared-types.ts";
import { formatWhen, plural } from "./feed.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface HistoryHandlers {
  open(item: HistoryItem): void;
  clear(): void;
}

/** Fills `root` with a header (with Clear, which asks twice) and one row per past session. */
export function renderHistory(root: HTMLElement, items: HistoryItem[], handlers: HistoryHandlers): void {
  const head = el("div", "history-head");
  head.append(el("span", "history-title", "Past sessions"));
  if (items.length > 0) {
    const clear = el("button", "history-clear", "Clear");
    clear.type = "button";
    let disarm = 0;
    clear.addEventListener("mousedown", (event) => event.preventDefault());
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
    head.append(clear);
  }

  const list = el("div", "history-items");
  if (items.length === 0) list.append(el("p", "history-empty", "No past sessions yet."));
  const now = Date.now();
  items.forEach((item, index) => {
    const row = el("button", "history-item");
    row.type = "button";
    row.style.setProperty("--i", String(Math.min(index, 10)));
    if (item.windowTitle) row.title = item.windowTitle;
    const line = el("span", "history-line");
    line.append(el("span", "history-item-title", item.title || "Untitled"));
    if (item.current) {
      row.setAttribute("aria-current", "true");
      line.append(el("span", "history-tag", "This chat"));
    }
    const meta = [item.appName, formatWhen(item.updatedAt, now), item.turns > 1 ? plural(item.turns, "question") : null];
    row.append(line, el("span", "history-item-meta", meta.filter(Boolean).join(" · ")));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => handlers.open(item));
    list.append(row);
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
