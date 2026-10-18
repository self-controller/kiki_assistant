// Action cards: an event, task, email, edit, set of changes, form fill or presses Kiki proposes, editable in
// place. Nothing happens until the person presses one of its buttons.
import type { FieldValue, FormField, ProposedAction, TextChange } from "@kiki/shared";
import type { ActionMode, ActionRunResult, ActionStatus, EditInfo, SavedAction } from "../shared-types.ts";
import { diffParts } from "./diff.ts";
import { icon, type IconName } from "./icons.ts";

export interface CardOptions {
  /** A Google account is connected: add, draft and send directly. Otherwise, open Google in the browser. */
  google: boolean;
  /** Where edit cards write; without it, they can only be copied. */
  edit: EditInfo | undefined;
  /** The form fields fill cards set, by id. */
  fields: FormField[] | undefined;
  run(id: string, edited: ProposedAction, mode: ActionMode): Promise<ActionRunResult>;
  openSettings(): void;
  /** The card changed size. */
  onChange(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const KINDS: Record<ProposedAction["kind"], { label: string; icon: IconName }> = {
  event: { label: "Calendar event", icon: "calendar" },
  task: { label: "Task", icon: "listTodo" },
  email: { label: "Email", icon: "mail" },
  edit: { label: "Edit", icon: "pencil" },
  changes: { label: "Changes", icon: "replaceAll" },
  fill: { label: "Fill in", icon: "form" },
  press: { label: "Press", icon: "pointerClick" },
};

type Field = HTMLInputElement | HTMLTextAreaElement;

function field(label: string, control: Field, wide = false): HTMLLabelElement {
  const wrap = el("label", wide ? "card-field wide" : "card-field");
  wrap.append(el("span", undefined, label), control);
  return wrap;
}

function textInput(value: string | undefined, placeholder = ""): HTMLInputElement {
  const input = el("input");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

function textArea(value: string | undefined, rows: number): HTMLTextAreaElement {
  const area = el("textarea");
  area.value = value ?? "";
  area.rows = rows;
  return area;
}

const list = (value: string) =>
  value
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/** Where an edit card's text goes, as a line above it. */
function editWhere(edit: EditInfo | undefined): HTMLElement {
  const where = el("div", "card-where");
  if (!edit) {
    where.textContent = "Kiki can't write in this window. Copy the text and paste it.";
  } else if (edit.kind === "terminal") {
    where.textContent = "Goes in at the terminal's prompt. It won't run until you press Enter.";
  } else if (edit.mode === "insert") {
    where.textContent = "Goes in at your cursor.";
  } else {
    where.append(el("span", undefined, "Replaces "), el("q", undefined, edit.original));
  }
  return where;
}

/** Context around a change, cut to its last (or first) few words. */
function around(text: string, side: "head" | "tail"): string {
  const words = 4;
  const parts = text.split(/(?<=\s)/);
  if (parts.length <= words) return text;
  return side === "head" ? `…${parts.slice(-words).join("")}` : `${parts.slice(0, words).join("")}…`;
}

/** One change as a line: some context, what goes (struck through) and what comes in. */
function diffLine(change: TextChange): HTMLElement {
  const { head, removed, added, tail } = diffParts(change.find, change.replace);
  const line = el("span", "diff");
  if (head) line.append(el("span", "diff-context", around(head, "head")));
  if (removed) line.append(el("del", undefined, removed));
  if (added) line.append(el("ins", undefined, added));
  if (tail) line.append(el("span", "diff-context", around(tail, "tail")));
  return line;
}

/** A row with a tick box, its line, and (for changes) the replacement to edit when the line is clicked. */
function pickRow(content: HTMLElement, editor?: HTMLTextAreaElement | HTMLInputElement): { row: HTMLElement; tick: HTMLInputElement } {
  const row = el("div", "pick");
  const tick = el("input");
  tick.type = "checkbox";
  tick.checked = true;
  const line = el("label", "pick-line");
  line.append(tick, content);
  row.append(line);
  if (editor) {
    editor.hidden = editor instanceof HTMLTextAreaElement;
    row.append(editor);
  }
  return { row, tick };
}

/** Where a changes card writes, as a line above it. */
function changesWhere(edit: EditInfo | undefined): string {
  if (edit?.changes === "docs") return "In this Google Doc, with Docs' Find and replace. Each one goes in only where Docs finds it once.";
  if (edit?.changes) return "In the text your cursor is in. Click a change to edit it.";
  return edit?.wholeText ? "Kiki can't write here now; copy the text with the changes." : "Kiki can't write here now.";
}

/** Builds the card's fields; `read` returns the action as edited. */
function buildFields(
  action: ProposedAction,
  edit: EditInfo | undefined,
  fields: FormField[] | undefined,
  onPick: (picked: number) => void,
): { nodes: HTMLElement[]; read(): ProposedAction } {
  switch (action.kind) {
    case "event": {
      const title = textInput(action.title);
      const allDay = el("input");
      allDay.type = "checkbox";
      allDay.checked = Boolean(action.allDay);
      const start = el("input");
      const end = el("input");
      const setType = () => {
        const type = allDay.checked ? "date" : "datetime-local";
        for (const [input, value] of [
          [start, start.value || action.start],
          [end, end.value || action.end],
        ] as const) {
          const date = value.slice(0, 10);
          const time = value.length > 10 ? value.slice(11, 16) : "09:00";
          input.type = type;
          input.value = allDay.checked ? date : `${date}T${time}`;
        }
      };
      setType();
      allDay.addEventListener("change", setType);
      const location = textInput(action.location);
      const attendees = textInput(action.attendees?.join(", "), "Only you");
      const description = textArea(action.description, 2);
      const allDayLabel = el("label", "card-field check");
      allDayLabel.append(allDay, el("span", undefined, "All day"));
      return {
        nodes: [
          field("Title", title, true),
          field("Starts", start, true),
          field("Ends", end, true),
          allDayLabel,
          field("Where", location, true),
          field("Invite", attendees, true),
          field("Notes", description, true),
        ],
        read: () => ({
          ...action,
          title: title.value,
          start: start.value,
          end: end.value,
          allDay: allDay.checked,
          location: location.value,
          description: description.value,
          attendees: list(attendees.value),
        }),
      };
    }
    case "task": {
      const title = textInput(action.title);
      const due = el("input");
      due.type = "date";
      due.value = action.due ?? "";
      const notes = textArea(action.notes, 2);
      return {
        nodes: [field("Task", title, true), field("Due", due), field("Notes", notes, true)],
        read: () => ({ ...action, title: title.value, due: due.value, notes: notes.value }),
      };
    }
    case "email": {
      const to = textInput(action.to.join(", "), "name@example.com");
      const cc = textInput(action.cc?.join(", "));
      const subject = textInput(action.subject);
      const body = textArea(action.body, Math.min(10, Math.max(4, action.body.split("\n").length + 1)));
      return {
        nodes: [field("To", to, true), field("Cc", cc, true), field("Subject", subject, true), field("Message", body, true)],
        read: () => ({ ...action, to: list(to.value), cc: list(cc.value), subject: subject.value, body: body.value }),
      };
    }
    case "edit": {
      const text = textArea(action.text, Math.min(10, Math.max(3, action.text.split("\n").length + 1)));
      text.spellcheck = false;
      // Code and commands keep their columns.
      if (edit?.kind === "editor" || edit?.kind === "terminal") text.classList.add("mono");
      return {
        nodes: [editWhere(edit), field("New text", text, true)],
        read: () => ({ ...action, text: text.value }),
      };
    }
    case "changes": {
      const list = el("div", "pick-list");
      const rows = action.changes.map((change) => {
        const editor = textArea(change.replace, Math.min(6, change.replace.split("\n").length + 1));
        editor.spellcheck = false;
        const line = diffLine(change);
        const picked = pickRow(line, editor);
        line.title = "Click to edit what it becomes";
        line.addEventListener("click", (event) => {
          event.preventDefault();
          editor.hidden = !editor.hidden;
          if (!editor.hidden) editor.focus();
        });
        // The line follows the edit, so it shows what will go in.
        editor.addEventListener("input", () => line.replaceChildren(...diffLine({ find: change.find, replace: editor.value }).childNodes));
        list.append(picked.row);
        return { change, editor, tick: picked.tick };
      });
      const count = () => rows.filter((row) => row.tick.checked).length;
      for (const row of rows) row.tick.addEventListener("change", () => onPick(count()));
      const where = el("div", "card-where", changesWhere(edit));
      return {
        nodes: [where, list],
        read: () => ({
          ...action,
          changes: rows.filter((row) => row.tick.checked).map((row) => ({ find: row.change.find, replace: row.editor.value })),
        }),
      };
    }
    case "fill": {
      const list = el("div", "pick-list");
      const rows = action.fields.map((item) => {
        const info = fields?.find((candidate) => candidate.id === item.field);
        const label = el("span", "fill-label", info?.label || item.field);
        const content = el("span", "fill-row");
        content.append(label);
        let input: HTMLInputElement | HTMLTextAreaElement | undefined;
        if (typeof item.value === "boolean") {
          content.append(el("span", "fill-toggle", item.value ? (info?.kind === "radio" ? "select" : "check") : "uncheck"));
        } else {
          input = info?.kind === "textarea" ? textArea(item.value, 2) : textInput(item.value);
          input.addEventListener("click", (event) => event.preventDefault());
          content.append(input);
        }
        if (info?.value) content.append(el("span", "fill-was", `was ${JSON.stringify(info.value)}`));
        const picked = pickRow(content);
        list.append(picked.row);
        return { item, input, tick: picked.tick };
      });
      const count = () => rows.filter((row) => row.tick.checked).length;
      for (const row of rows) row.tick.addEventListener("change", () => onPick(count()));
      return {
        nodes: [el("div", "card-where", fields ? "Fills these fields on the page." : "Kiki can't reach this form now."), list],
        read: () => ({
          ...action,
          fields: rows
            .filter((row) => row.tick.checked)
            .map((row): FieldValue => ({ field: row.item.field, value: row.input ? row.input.value : row.item.value })),
        }),
      };
    }
    case "press": {
      const list = el("div", "pick-list");
      const rows = action.presses.map((press) => {
        const content = el("span", "press-row");
        content.append(el("span", "press-label", press.label ?? press.control));
        // Which one: the text just before it on screen.
        if (press.near) content.append(el("span", "press-near", `after “${press.near}”`));
        const picked = pickRow(content);
        list.append(picked.row);
        return { press, tick: picked.tick };
      });
      const count = () => rows.filter((row) => row.tick.checked).length;
      for (const row of rows) row.tick.addEventListener("change", () => onPick(count()));
      return {
        nodes: [el("div", "card-where", "Presses these in the window your question came from."), list],
        read: () => ({ ...action, presses: rows.filter((row) => row.tick.checked).map((row) => row.press) }),
      };
    }
  }
}

interface Button {
  label: string;
  mode: ActionMode;
  primary?: boolean;
}

function editButtons(edit: EditInfo | undefined): Button[] {
  if (!edit) return [{ label: "Copy", mode: "copy", primary: true }];
  const label = edit.kind === "terminal" ? "Paste" : edit.mode === "replace" ? "Replace" : "Insert";
  return [
    { label, mode: "apply", primary: true },
    { label: "Copy", mode: "copy" },
  ];
}

function buttonsFor(action: ProposedAction, options: CardOptions): Button[] | null {
  if (action.kind === "edit") return editButtons(options.edit);
  if (action.kind === "changes") {
    return [
      ...(options.edit?.changes ? [{ label: applyLabel(action.changes.length), mode: "apply" as const, primary: true }] : []),
      ...(options.edit?.wholeText ? [{ label: "Copy all", mode: "copy" as const, primary: !options.edit.changes }] : []),
    ];
  }
  if (action.kind === "fill") return options.fields ? [{ label: fillLabel(action.fields.length), mode: "apply", primary: true }] : [];
  if (action.kind === "press") return [{ label: pressLabel(action.presses.length), mode: "apply", primary: true }];
  if (!options.google) {
    if (action.kind === "task") return null;
    return [{ label: action.kind === "event" ? "Open in Google Calendar" : "Open in Gmail", mode: "open", primary: true }];
  }
  switch (action.kind) {
    case "event":
      return [{ label: "Add to Calendar", mode: "add", primary: true }];
    case "task":
      return [{ label: "Add task", mode: "add", primary: true }];
    case "email":
      return action.send
        ? [
            { label: "Send", mode: "send", primary: true },
            { label: "Save draft", mode: "draft" },
          ]
        : [
            { label: "Save draft", mode: "draft", primary: true },
            { label: "Send", mode: "send" },
          ];
  }
}

const applyLabel = (count: number) => (count === 1 ? "Apply 1 change" : `Apply ${count} changes`);
const fillLabel = (count: number) => (count === 1 ? "Fill 1 field" : `Fill ${count} fields`);
const pressLabel = (count: number) => (count === 1 ? "Press" : `Press ${count}`);

function statusLine(status: ActionStatus): HTMLElement {
  const line = el("div", `card-status ${status.outcome}`);
  if (status.outcome !== "failed" && status.outcome !== "dismissed") line.append(icon("check", 13, 2.5));
  line.append(el("span", undefined, status.message));
  if (status.link) {
    const link = el("a", undefined, "Open");
    link.href = status.link;
    line.append(link);
  }
  return line;
}

/** An action card, live (with fields and buttons) or finished (a summary and what happened). */
export function renderActionCard(saved: SavedAction, options: CardOptions): HTMLElement {
  const root = el("div", "action-card");
  const kind = KINDS[saved.action.kind];
  const head = el("div", "card-head");
  head.append(icon(kind.icon, 14), el("span", undefined, kind.label));
  root.append(head);

  const finished = saved.status && saved.status.outcome !== "failed";
  if (finished) {
    root.classList.add("finished");
    root.append(el("div", "card-title", titleOf(saved.action, options.fields)), statusLine(saved.status!));
    return root;
  }

  // Ticking changes (or fields) on and off updates the count on the main button.
  const onPick = (picked: number) => {
    const main = buttons[0];
    if (!main || saved.action.kind === "edit") return;
    if (saved.action.kind === "changes" && options.edit?.changes) main.textContent = applyLabel(picked);
    if (saved.action.kind === "fill") main.textContent = fillLabel(picked);
    if (saved.action.kind === "press") main.textContent = pressLabel(picked);
    main.disabled = picked === 0;
  };
  const { nodes, read } = buildFields(saved.action, options.edit, options.fields, onPick);
  const fields = el("div", "card-fields");
  fields.append(...nodes);
  const actions = el("div", "card-actions");
  const error = el("div", "card-status failed");
  error.hidden = !saved.status;
  if (saved.status) error.textContent = saved.status.message;
  root.append(fields, error, actions);

  const buttons: HTMLButtonElement[] = [];
  const press = async (mode: ActionMode) => {
    for (const button of buttons) button.disabled = true;
    const result = await options.run(saved.action.id, read(), mode).catch(
      (failure: unknown): ActionRunResult => ({ ok: false, message: String(failure) }),
    );
    if (result.ok) {
      root.replaceWith(renderActionCard(result.saved, options));
    } else {
      for (const button of buttons) button.disabled = false;
      error.textContent = result.message;
      error.hidden = false;
    }
    options.onChange();
  };

  const choices = buttonsFor(saved.action, options);
  if (choices) {
    for (const choice of choices) {
      const button = el("button", choice.primary ? "primary" : undefined, choice.label);
      button.type = "button";
      button.addEventListener("click", () => void press(choice.mode));
      buttons.push(button);
      actions.append(button);
    }
  } else {
    const connect = el("button", "primary", "Connect Google");
    connect.type = "button";
    connect.addEventListener("click", () => options.openSettings());
    actions.append(connect);
  }
  const dismiss = el("button", "quiet", "Not now");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => void press("dismiss"));
  buttons.push(dismiss);
  actions.append(dismiss);
  return root;
}

function titleOf(action: ProposedAction, fields: FormField[] | undefined): string {
  switch (action.kind) {
    case "event": {
      const when = action.allDay ? action.start.slice(0, 10) : action.start.replace("T", " ");
      return `${action.title} · ${when}`;
    }
    case "task":
      return action.due ? `${action.title} · due ${action.due}` : action.title;
    case "email":
      return `${action.subject || "(no subject)"} → ${action.to.join(", ") || "no recipient"}`;
    case "edit": {
      const line = action.text.trim().split("\n")[0] ?? "";
      return line.length > 80 ? `${line.slice(0, 80)}…` : line;
    }
    case "changes": {
      const first = diffParts(action.changes[0]!.find, action.changes[0]!.replace);
      const more = action.changes.length > 1 ? ` and ${action.changes.length - 1} more` : "";
      return `${first.removed || "…"} → ${first.added || "(removed)"}${more}`;
    }
    case "fill":
      return action.fields.map((item) => fields?.find((field) => field.id === item.field)?.label || item.field).join(", ");
    case "press":
      return action.presses.map((press) => press.label ?? press.control).join(", ");
  }
}
