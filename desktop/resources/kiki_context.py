#!/usr/bin/python3
"""Kiki's Linux context helper. Prints one JSON object to stdout.

  kiki_context.py              Active app, window title and visible text via AT-SPI
                               (terminals and editors: only the text around the selection or caret),
                               and where Kiki could write at the cursor ("edit")
  kiki_context.py --edit JSON  Writes text where an earlier read's "edit" pointed: {"pid", "path", "role",
                               "start", "end", "expected", "text", "whole"?}
  kiki_context.py --check-changes JSON   Finds each change's text in an editable object, once:
                               {"pid", "path", "role", "changes": [{"find", "replace"}]}
  kiki_context.py --apply-changes JSON   Writes those changes over AT-SPI (toolkits that take writes)
  kiki_context.py --select JSON  Selects text to paste over: {"pid", "path", "role"} plus {"find"}, or
                               {"start", "end", "expected"}, or {"all": true}
  kiki_context.py --verify JSON  Checks that {"pid", "path", "role", "start", "text"} is there now
  kiki_context.py --press JSON   Clicks a check box, button or link: {"pid", "path", "role", "checked"?, "name"?}
  kiki_context.py --check-presses JSON  Whether each of {"pid", "controls": [{"path", "role", "name"}]} is still
                               there to press
  kiki_context.py --screen JSON  What's on screen now in the window an earlier read found: {"pid", "window"}
  kiki_context.py --scroll JSON  Scrolls a page there over AT-SPI, then reads the screen: {"pid", "window"} plus
                               {"direction": "down" | "up"} or {"to": text on the page}
  kiki_context.py --docs-dialog JSON  Google Docs' Find and replace dialog in the app with {"pid"}
  kiki_context.py --screenshot Full-screen screenshot via the XDG desktop portal
  kiki_context.py --delay 3    Wait first (for testing: highlight text, then switch windows)
  kiki_context.py --check      Exit successfully if AT-SPI is importable

Must run under the system Python (with PyGObject), e.g. /usr/bin/python3.
"""

import argparse
import json
import re
import secrets
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib  # noqa: E402

EMBEDDED_OBJECT = "￼"
# Marks where on-screen text starts while a page is read; never in the output.
ON_SCREEN = "\ue000"
# Where a control is in a screen read's text: CONTROL_START, its index in "controls", CONTROL_LABEL, its label,
# CONTROL_END. Kiki turns each into "⟦b3 Like⟧".
CONTROL_START, CONTROL_LABEL, CONTROL_END = "\ue001", "\ue002", "\ue003"
# Roles that start a new line when their text is joined with siblings'.
BLOCK_ROLES = {
    Atspi.Role.PARAGRAPH,
    Atspi.Role.HEADING,
    Atspi.Role.LIST_ITEM,
    Atspi.Role.SECTION,
    Atspi.Role.TABLE_ROW,
    Atspi.Role.TABLE_CELL,
    Atspi.Role.BLOCK_QUOTE,
    Atspi.Role.ARTICLE,
    Atspi.Role.FORM,
    Atspi.Role.DOCUMENT_WEB,
    Atspi.Role.DOCUMENT_TEXT,
    Atspi.Role.TERMINAL,
    Atspi.Role.TEXT,
    Atspi.Role.ENTRY,
    Atspi.Role.LABEL,
}
SKIP_ROLES = {
    Atspi.Role.MENU_BAR,
    Atspi.Role.MENU,
    Atspi.Role.TOOL_BAR,
    Atspi.Role.STATUS_BAR,
    Atspi.Role.SCROLL_BAR,
    Atspi.Role.IMAGE,
}
# Where find_anchor looks for the cursor: toolbars too, which hold browsers' address and search bars.
ANCHOR_SKIP_ROLES = SKIP_ROLES - {Atspi.Role.TOOL_BAR}
DOCUMENT_ROLES = {Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME}
# Text where only the lines around the selection or caret matter: terminals and multi-line editors.
EDITOR_ROLES = {Atspi.Role.TEXT, Atspi.Role.DOCUMENT_TEXT, Atspi.Role.ENTRY}
# How much to read on each side of the selection or caret; Kiki trims it to whole lines.
VICINITY_BEFORE = 16_000
VICINITY_AFTER = 8_000
# How far from where it was read an edit looks for the text it replaces, if that has moved.
RELOCATE_CHARS = 4_000
# Toolkits whose AT-SPI text writes do nothing (Firefox and Zen, verified) or aren't known to work (Chromium,
# Electron): Kiki selects the text there over AT-SPI and pastes over it instead.
SELECT_PASTE_TOOLKITS = {"gecko", "chromium"}
# The most of an editable text (a field, a compose box) Kiki reads whole, to change it in several places.
EDITABLE_CHARS = 16_000
# The most text read from one editable object (and what it embeds) to find changes in.
FLATTEN_CHARS = 400_000
# Fields a form fill can set: text fields (never passwords), check boxes and radio buttons.
TEXT_FIELD_ROLES = {Atspi.Role.ENTRY, Atspi.Role.TEXT}
TOGGLE_ROLES = {Atspi.Role.CHECK_BOX, Atspi.Role.RADIO_BUTTON}
MAX_FIELDS = 40
FIELD_VALUE_CHARS = 200
# What a press card can press on screen: buttons, links, tabs. Check boxes and radio buttons are fields.
CONTROL_ROLES = {
    Atspi.Role.PUSH_BUTTON,
    Atspi.Role.BUTTON,
    Atspi.Role.TOGGLE_BUTTON,
    Atspi.Role.LINK,
    Atspi.Role.MENU_ITEM,
    Atspi.Role.PAGE_TAB,
}
MAX_CONTROLS = 300
# A control's label, at most; a control holding more text (a link around a whole post) keeps its text.
CONTROL_LABEL_CHARS = 120
WINDOW_ROLES = {Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG}
# Where a page scrolls the text it brings back into view: this far below the window's top, below a sticky header.
SCROLL_TO_Y = 200
# Where a page scrolls the last line on screen when it moves down a screen, so it shows again at the top.
NEXT_SCREEN_Y = 120


class Budget:
    def __init__(self, max_chars, max_seconds, max_nodes):
        self.chars_left = max_chars
        self.deadline = time.monotonic() + max_seconds
        self.nodes_left = max_nodes
        # Selected text found along the way, in reading order.
        self.selections = []
        # The length of each on-screen text marked with ON_SCREEN, in reading order.
        self.on_screen = []
        # The first focused, editable object along the way: where the cursor is.
        self.focused_editable = None
        # Fields a form fill could set, in reading order; see note_field().
        self.fields = []
        # A screen read (read_screen()): only what's on screen, and the controls there to press, in reading order.
        self.screen_only = False
        self.controls = None

    def exhausted(self):
        return self.chars_left <= 0 or self.nodes_left <= 0 or time.monotonic() > self.deadline


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # AT-SPI calls fail freely when apps change or hang.
        return default


def indexed_children(obj):
    """obj's children with their indices, which find_by_path() follows back to them."""
    count = safe(obj.get_child_count, 0) or 0
    for index in range(min(count, 500)):
        child = safe(lambda: obj.get_child_at_index(index))
        if child is not None:
            yield index, child


def children(obj):
    for _index, child in indexed_children(obj):
        yield child


def is_visible(obj):
    return visible_states(safe(obj.get_state_set))


def visible_states(states):
    if states is None:
        return True
    return states.contains(Atspi.StateType.SHOWING) or states.contains(Atspi.StateType.VISIBLE)


def own_text(obj, budget):
    """The object's own text (may contain U+FFFC for embedded children), or None.

    Also records any text selected inside it, which is fresher than the primary selection.
    """
    iface = safe(obj.get_text_iface)
    if iface is None:
        return None
    count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
    if count <= 0:
        return ""
    text = safe(lambda: Atspi.Text.get_text(iface, 0, min(count, 200_000)), "") or ""
    for index in range(safe(lambda: Atspi.Text.get_n_selections(iface), 0) or 0):
        selected = safe(lambda: Atspi.Text.get_selection(iface, index))
        if selected is not None and selected.end_offset > selected.start_offset:
            piece = text[selected.start_offset : selected.end_offset].replace(EMBEDDED_OBJECT, "").strip()
            if piece:
                budget.selections.append(piece)
    return text


def collect(obj, budget, depth=0, path=()):
    """Reading-order text for obj's subtree, stopping when the budget runs out.

    Also notes the fields a form fill could set, with their child-index paths from the first obj.
    """
    if budget.exhausted() or depth > 60:
        return ""
    budget.nodes_left -= 1
    role = safe(obj.get_role)
    states = safe(obj.get_state_set)
    if role in SKIP_ROLES or not visible_states(states):
        return ""
    showing = states is None or states.contains(Atspi.StateType.SHOWING)
    # Browsers clear "showing" on what's scrolled out of view, and so on everything inside it.
    if budget.screen_only and not showing:
        return ""
    if (
        budget.focused_editable is None
        and states is not None
        and states.contains(Atspi.StateType.FOCUSED)
        and states.contains(Atspi.StateType.EDITABLE)
    ):
        budget.focused_editable = obj
    if role in TEXT_FIELD_ROLES or role in TOGGLE_ROLES:
        note_field(obj, role, states, path, budget)
    text = collect_text(obj, role, states, budget, depth, path)
    if budget.controls is not None and role in CONTROL_ROLES and len(budget.controls) < MAX_CONTROLS:
        return control_marker(obj, role, text, path, budget)
    return text


def collect_text(obj, role, states, budget, depth, path):
    """collect()'s text for obj: its own, with its children's spliced in, or else its children's joined."""
    text = own_text(obj, budget)
    if text is None:
        # No text of its own: join the children's text.
        parts = []
        for index, child in indexed_children(obj):
            part = collect(child, budget, depth + 1, (*path, index))
            if part.strip():
                parts.append(part)
            if budget.exhausted():
                break
        return "\n".join(parts)

    multi_line = states is not None and states.contains(Atspi.StateType.MULTI_LINE)
    if budget.screen_only and role in EDITOR_ROLES and multi_line and EMBEDDED_OBJECT not in text:
        text = visible_lines(obj, text)
    own = text.replace(EMBEDDED_OBJECT, "")
    budget.chars_left -= len(own)
    # Browsers clear "showing" on what is scrolled out of view.
    if not budget.screen_only and own.strip() and states is not None and states.contains(Atspi.StateType.SHOWING):
        # Ahead of the children's text, so the markers come in the order of budget.on_screen.
        text = ON_SCREEN + text
        budget.on_screen.append(len(own))
    if EMBEDDED_OBJECT in text:
        # Hypertext: each U+FFFC stands for the next child (a link, an inline element...).
        pieces = text.split(EMBEDDED_OBJECT)
        out = [pieces[0]]
        kids = list(indexed_children(obj))
        for index, piece in enumerate(pieces[1:]):
            if index < len(kids) and not budget.exhausted():
                child_index, kid = kids[index]
                child_role = safe(kid.get_role)
                child_text = collect(kid, budget, depth + 1, (*path, child_index))
                out.append(("\n" + child_text + "\n") if child_role in BLOCK_ROLES else child_text)
            out.append(piece)
        return "".join(out)
    return text


def control_label(obj):
    """What a control says: its name, on one line and cut to CONTROL_LABEL_CHARS. Empty without one."""
    return " ".join((safe(obj.get_name) or "").split())[:CONTROL_LABEL_CHARS]


def control_marker(obj, role, text, path, budget):
    """Notes a control a press card could press, and marks it in the text in place of its own words.

    Only controls with a name: the card has to say what it presses. A control around a lot of text (a link
    around a whole post) keeps that text after its marker.
    """
    label = control_label(obj)
    if not label:
        return text
    inner = " ".join(text.replace(EMBEDDED_OBJECT, " ").split())
    budget.controls.append({"path": list(path), "role": safe(obj.get_role_name), "name": label})
    marker = f"{CONTROL_START}{len(budget.controls) - 1}{CONTROL_LABEL}{label}{CONTROL_END}"
    if len(inner) <= CONTROL_LABEL_CHARS:
        # Links and buttons in running text stay in their line.
        return marker if role == Atspi.Role.LINK else f" {marker} "
    return f"{marker}\n{text}"


def visible_lines(obj, text):
    """The whole lines of a long text object (an editor) that are on screen, from the offsets at its corners.

    All of `text` when the toolkit can't say.
    """
    iface = safe(obj.get_text_iface)
    component = safe(obj.get_component_iface)
    extents = safe(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.WINDOW)) if component else None
    if iface is None or extents is None or extents.width <= 2 or extents.height <= 2:
        return text
    at = lambda x, y: safe(lambda: Atspi.Text.get_offset_at_point(iface, x, y, Atspi.CoordType.WINDOW), -1)  # noqa: E731
    start = at(extents.x + 1, extents.y + 1)
    end = at(extents.x + extents.width - 2, extents.y + extents.height - 2)
    if start is None or end is None or start < 0 or end <= start or end > len(text):
        return text
    start = text.rfind("\n", 0, start) + 1
    stop = text.find("\n", end)
    return text[start : len(text) if stop < 0 else stop]


def note_field(obj, role, states, path, budget):
    """Records a field a form fill could set: enabled, labelled, and editable plain text unless it's a toggle.

    A field without a label is nothing anyone could say what to put in (it's often the document itself).
    """
    if len(budget.fields) >= MAX_FIELDS or states is None or not states.contains(Atspi.StateType.ENABLED):
        return
    label = field_label(obj)
    if not label:
        return
    field = {
        "path": list(path),
        "role": safe(obj.get_role_name),
        "label": label,
        "onScreen": states.contains(Atspi.StateType.SHOWING),
    }
    if role in TOGGLE_ROLES:
        kind = "checkbox" if role == Atspi.Role.CHECK_BOX else "radio"
        field.update(kind=kind, checked=states.contains(Atspi.StateType.CHECKED))
    else:
        iface = safe(obj.get_text_iface)
        if iface is None or not states.contains(Atspi.StateType.EDITABLE):
            return
        count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
        value = safe(lambda: Atspi.Text.get_text(iface, 0, min(count, FIELD_VALUE_CHARS)), "") or ""
        # Rich text (a compose box) is for changes in several places, not for filling in.
        if EMBEDDED_OBJECT in value:
            return
        kind = "textarea" if states.contains(Atspi.StateType.MULTI_LINE) else "text"
        field.update(kind=kind, value=value, length=count)
    budget.fields.append(field)


def field_label(obj):
    """What a field is for: its name, else the label it points to, else its description."""
    name = (safe(obj.get_name) or "").strip()
    if not name:
        for relation in safe(obj.get_relation_set, []) or []:
            if safe(relation.get_relation_type) == Atspi.RelationType.LABELLED_BY and safe(relation.get_n_targets, 0):
                name = (safe(lambda: relation.get_target(0).get_name()) or "").strip()
                break
    if not name:
        name = (safe(obj.get_description) or "").strip()
    return " ".join(name.split())[:120]


def toolkit_of(app):
    """The app's toolkit, lowercase: "gtk", "gecko" (Firefox, Zen), "chromium" (Chrome, Electron), "qt"..."""
    return (safe(app.get_toolkit_name) or "").lower()


def has_state(obj, state):
    states = safe(obj.get_state_set)
    return states is not None and states.contains(state)


def selected_span(iface):
    """The first non-empty selection in a Text interface, as (start, end) offsets, or None."""
    for index in range(safe(lambda: Atspi.Text.get_n_selections(iface), 0) or 0):
        selected = safe(lambda: Atspi.Text.get_selection(iface, index))
        if selected is not None and selected.end_offset > selected.start_offset:
            return selected.start_offset, selected.end_offset
    return None


def vicinity_kind(obj):
    """The kind of text ("terminal" or "editor") where only the lines near the selection matter, or None."""
    role = safe(obj.get_role)
    if role == Atspi.Role.TERMINAL:
        return "terminal"
    if role in EDITOR_ROLES and has_state(obj, Atspi.StateType.MULTI_LINE):
        return "editor"
    return None


def find_anchor(obj, budget, found, depth=0, in_toolbar=False):
    """Looks for the text object holding the selection, noting the first focused one on the way.

    Reads no text. Skips web documents: pages go through collect(), which reads around the selection.
    Looks inside toolbars, where a browser keeps its address bar, but only at what has the cursor there.
    """
    if budget.exhausted() or depth > 60:
        return
    budget.nodes_left -= 1
    role = safe(obj.get_role)
    if role in ANCHOR_SKIP_ROLES or role in DOCUMENT_ROLES or not is_visible(obj):
        return
    in_toolbar = in_toolbar or role == Atspi.Role.TOOL_BAR
    iface = safe(obj.get_text_iface)
    # Hidden tabs are "visible" but not "showing"; their stale selections don't count.
    if iface is not None and has_state(obj, Atspi.StateType.SHOWING):
        focused = has_state(obj, Atspi.StateType.FOCUSED)
        # An address bar keeps its highlight after the person clicks into the page.
        span = selected_span(iface) if focused or not in_toolbar else None
        if span is not None:
            found["selected"] = (obj, iface, span)
            return
        if "focused" not in found and focused:
            found["focused"] = (obj, iface)
    for child in children(obj):
        find_anchor(child, budget, found, depth + 1, in_toolbar)
        if "selected" in found or budget.exhausted():
            return


def find_text_anchor(window, max_seconds):
    """The text object in window holding the selection, or else the focused one, or None.

    Returns (obj, iface, start, end); at a caret, start and end are both the caret offset (-1 if unknown).
    """
    found = {}
    find_anchor(window, Budget(1, max_seconds, max_nodes=3_000), found)
    if "selected" in found:
        obj, iface, (start, end) = found["selected"]
    elif "focused" in found:
        obj, iface = found["focused"]
        start = end = safe(lambda: Atspi.Text.get_caret_offset(iface), -1)
    else:
        return None
    return obj, iface, start, end


def read_vicinity(anchor):
    """The text around the selection (or the caret) of a terminal or editor, from find_text_anchor, or None.

    Returns {"kind", "before", "anchor", "after"}: "anchor" is the selected text ("" at a caret), and
    "before"/"after" are up to VICINITY_BEFORE/AFTER characters on either side, unnormalized so that
    indentation and columns survive.
    """
    if anchor is None:
        return None
    obj, iface, start, end = anchor
    # A selection somewhere else (a label, a list) leaves the whole window to collect().
    kind = vicinity_kind(obj)
    if kind is None or start < 0:
        return None

    count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
    low, high = max(0, start - VICINITY_BEFORE), min(count, end + VICINITY_AFTER)
    text = safe(lambda: Atspi.Text.get_text(iface, low, high), "") or ""
    # Embedded objects need collect() to splice their children in; a short read means stale offsets.
    # VTE has no text until its screen first changes with accessibility on.
    if EMBEDDED_OBJECT in text or len(text) < end - low or not text.strip():
        return None
    return {
        "kind": kind,
        "before": text[: start - low],
        "anchor": text[start - low : end - low],
        "after": text[end - low :],
    }


def index_in_parent(node, parent):
    """node's index among parent's children, or None.

    Some toolkits (GTK 3) report wrong indices, so the reported one is checked, by object path, and the
    children searched when it's off.
    """
    path = safe(lambda: node.path)
    reported = safe(node.get_index_in_parent, -1)
    if reported is not None and reported >= 0:
        child = safe(lambda: parent.get_child_at_index(reported))
        if child is not None and safe(lambda: child.path) == path:
            return reported
    for index in range(min(safe(parent.get_child_count, 0) or 0, 500)):
        child = safe(lambda: parent.get_child_at_index(index))
        if child is not None and safe(lambda: child.path) == path:
            return index
    return None


def path_from_app(obj):
    """Child indices from obj's application down to obj, or None when the chain breaks."""
    path = []
    node = obj
    for _ in range(100):
        if safe(node.get_role) == Atspi.Role.APPLICATION:
            return path[::-1]
        parent = safe(node.get_parent)
        index = index_in_parent(node, parent) if parent is not None else None
        if index is None:
            return None
        path.append(index)
        node = parent
    return None


def edit_target(app, obj, start=None, end=None):
    """Where Kiki could write at the cursor in obj, for a later --edit, or None.

    Without offsets, they come from obj's selection, or else its caret. "editable" says whether AT-SPI can
    write there; terminals and rich text (with embedded objects) need a paste instead.
    """
    iface = safe(obj.get_text_iface)
    if iface is None:
        return None
    if start is None:
        span = selected_span(iface)
        start, end = span if span else (safe(lambda: Atspi.Text.get_caret_offset(iface), -1),) * 2
    if start is None or start < 0 or end < start:
        return None
    path = path_from_app(obj)
    if path is None:
        return None
    expected = safe(lambda: Atspi.Text.get_text(iface, start, end), "") if end > start else ""
    if expected is None or len(expected) != end - start:
        return None
    role = safe(obj.get_role)
    if role == Atspi.Role.TERMINAL:
        kind = "terminal"
    elif has_state(obj, Atspi.StateType.MULTI_LINE):
        kind = "editor"
    else:
        kind = "field"
    editable = (
        kind != "terminal"
        and has_state(obj, Atspi.StateType.EDITABLE)
        and safe(obj.get_editable_text_iface) is not None
        and EMBEDDED_OBJECT not in expected
    )
    return {
        "pid": safe(app.get_process_id),
        "path": path,
        "role": safe(obj.get_role_name),
        "start": start,
        "end": end,
        "expected": expected,
        "editable": bool(editable),
        "kind": kind,
        "toolkit": toolkit_of(app),
    }


def anchor_target(app, anchor):
    """The edit target at find_text_anchor's object: an editable text or a terminal, else None."""
    if anchor is None:
        return None
    obj, _iface, start, end = anchor
    if safe(obj.get_role) != Atspi.Role.TERMINAL and not has_state(obj, Atspi.StateType.EDITABLE):
        return None
    return edit_target(app, obj, start, end)


def find_active_window(desktop):
    for app in children(desktop):
        for window in children(app):
            states = safe(window.get_state_set)
            if states is not None and states.contains(Atspi.StateType.ACTIVE):
                return app, window
    return None, None


def find_document(obj):
    """The active tab's web document under obj (browsers), so we skip toolbars and other tabs.

    Every tab keeps a "visible" document; only the active tab's is "showing". Falls back to the
    first visible document for apps that don't set "showing".
    """
    found = {}

    def walk(node, depth):
        if depth > 25:
            return False
        if safe(node.get_role) in DOCUMENT_ROLES and is_visible(node):
            if has_state(node, Atspi.StateType.SHOWING):
                found["showing"] = node
                return True
            found.setdefault("visible", node)
            # Nested documents (iframes) are read through their parent by collect().
            return False
        return any(walk(child, depth + 1) for child in children(node))

    walk(obj, 0)
    return found.get("showing") or found.get("visible")


def settle_markers(text):
    """Moves each ON_SCREEN marker past whitespace and embedded objects, onto the text it marks."""
    out, pending = [], ""
    for char in text:
        if char == ON_SCREEN:
            pending += char
        elif char.isspace() or char == EMBEDDED_OBJECT:
            out.append(char)
        else:
            out.append(pending + char)
            pending = ""
    return "".join(out) + pending


def split_focus(text, on_screen, read_chars):
    """Removes the ON_SCREEN markers from normalized text.

    Returns the text and the offset of the middle of its on-screen part, or None when the whole read was
    on screen (or none of it was).
    """
    positions = [index for index, char in enumerate(text) if char == ON_SCREEN]
    clean = text.replace(ON_SCREEN, "")
    shown = sum(on_screen)
    if not shown or shown >= read_chars or len(positions) != len(on_screen):
        return clean, None
    running = 0
    for index, length in enumerate(on_screen):
        running += length
        if running * 2 >= shown:
            # The markers before this one are gone from the clean text.
            return clean, positions[index] - index
    return clean, None


def normalize(text):
    lines = [" ".join(line.split()) for line in text.replace(EMBEDDED_OBJECT, "").splitlines()]
    out, blank = [], False
    for line in lines:
        if line:
            out.append(line)
            blank = False
        elif not blank and out:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def capture_context(max_chars, max_seconds):
    desktop = Atspi.get_desktop(0)
    app, window = find_active_window(desktop)
    if window is None:
        # Nothing focused is exposed over AT-SPI (e.g. a browser with accessibility off).
        return {"ok": True, "appName": None, "windowTitle": None, "text": "", "selection": "", "source": "none"}

    return read_window(app, window, max_chars, max_seconds)


def read_window(app, window, max_chars, max_seconds):
    """What capture_context reports for one window; tests call it on windows that aren't active.

    For pages, "focus" is the offset in "text" of the middle of what is on screen, when some of it isn't.
    """
    names = {
        "ok": True,
        "appName": safe(app.get_name),
        "windowTitle": safe(window.get_name),
        "pid": safe(app.get_process_id),
        "toolkit": toolkit_of(app),
        # So --screen and --scroll can find this window again once Kiki's popup is the active one.
        "window": path_from_app(window),
    }
    anchor = find_text_anchor(window, max_seconds / 2)
    target = anchor_target(app, anchor)
    vicinity = read_vicinity(anchor)
    if vicinity is not None:
        result = {**names, "text": "", "selection": vicinity["anchor"], "source": vicinity["kind"], "vicinity": vicinity}
        return {**result, "edit": target} if target else result

    budget = Budget(max_chars, max_seconds, max_nodes=20_000)
    document = find_document(window)
    root = document or window
    raw = collect(root, budget)
    text, focus = split_focus(normalize(settle_markers(raw)), budget.on_screen, max_chars - budget.chars_left)
    result = {
        **names,
        "text": text,
        "selection": normalize("\n".join(budget.selections)),
        "source": "document" if document is not None else "window",
        "truncated": budget.exhausted(),
    }
    if focus is not None:
        result["focus"] = focus
    url = document_url(document) if document is not None else None
    if url:
        result["url"] = url
    # One field alone is where the cursor is, for an edit; a form has more.
    base = path_from_app(root) if len(budget.fields) >= 2 else None
    if base is not None:
        result["fields"] = [{**field, "path": base + field["path"]} for field in budget.fields]
    # A focused field in a page (or the window) beats a caret found outside it.
    target_obj = anchor[0] if target and anchor else None
    if budget.focused_editable is not None:
        focused = edit_target(app, budget.focused_editable)
        if focused:
            target, target_obj = focused, budget.focused_editable
    if target:
        # The whole field (or compose box), so Kiki can change it in several places.
        if target["kind"] != "terminal" and target_obj is not None:
            target["full"] = editable_text(target_obj, target["start"])
        result["edit"] = target
        # collect() doesn't read toolbars: text highlighted in an address bar is only here.
        if not result["selection"] and target["expected"].strip():
            result["selection"] = target["expected"].strip()
    return result


def document_url(document):
    """The address of a browser's web document, or None."""
    iface = safe(document.get_document_iface)
    if iface is None:
        return None
    return safe(lambda: Atspi.Document.get_document_attribute_value(iface, "DocURL")) or None


def text_runs(obj, runs, budget, depth=0):
    """Appends the text of obj and what it embeds to `runs`, in reading order.

    Each run is (node, offset in the node's own text, text); (None, 0, "\n") marks a block's edge. Rich text
    (a compose box) is a tree: each line a child, standing in its parent's text as U+FFFC.
    """
    if depth > 40 or budget[0] <= 0:
        return
    iface = safe(obj.get_text_iface)
    if iface is None:
        for child in children(obj):
            runs.append((None, 0, "\n"))
            text_runs(child, runs, budget, depth + 1)
        return
    count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
    text = safe(lambda: Atspi.Text.get_text(iface, 0, min(count, budget[0])), "") or ""
    budget[0] -= len(text)
    if EMBEDDED_OBJECT not in text:
        if text:
            runs.append((obj, 0, text))
        return
    pieces = text.split(EMBEDDED_OBJECT)
    kids = list(children(obj))
    offset = 0
    for index, piece in enumerate(pieces):
        if piece:
            runs.append((obj, offset, piece))
        offset += len(piece) + 1
        if index < len(pieces) - 1 and index < len(kids):
            block = safe(kids[index].get_role) in BLOCK_ROLES
            if block:
                runs.append((None, 0, "\n"))
            text_runs(kids[index], runs, budget, depth + 1)
            if block:
                runs.append((None, 0, "\n"))


def flatten(obj):
    """obj's text as one string, with a line break between blocks, and where each piece of it lives.

    Returns (text, placed): `placed` holds (offset in text, node, offset in node's text, run text) per run.
    The same object always flattens the same way, so offsets from one read hold for the next.
    """
    runs = []
    text_runs(obj, runs, [FLATTEN_CHARS])
    out, placed, at, pending = [], [], 0, False
    for node, start, text in runs:
        if node is None:
            pending = at > 0
            continue
        if pending:
            out.append("\n")
            at += 1
            pending = False
        placed.append((at, node, start, text))
        out.append(text)
        at += len(text)
    return "".join(out), placed


def editable_text(obj, around):
    """The text changes in several places see (flatten()), cut to EDITABLE_CHARS around a plain text's caret."""
    text, placed = flatten(obj)
    if len(text) <= EDITABLE_CHARS:
        return {"text": text}
    # A plain field is one run, so its caret offset is an offset in the text; rich text keeps its start.
    middle = around if len(placed) == 1 and placed[0][2] == 0 else 0
    start = max(0, min(middle - EDITABLE_CHARS // 2, len(text) - EDITABLE_CHARS))
    return {"text": text[start : start + EDITABLE_CHARS], "truncated": True}


def locate(text, placed, find):
    """Where `find` is, when it's in `text` exactly once and within one run: {"node", "start", "at"}.

    Otherwise {"status": "missing" | "ambiguous" | "spans", "count"}: "spans" when it crosses from one line
    or block (one object) into the next, where neither a write nor a selection can cover it.
    """
    first = text.find(find)
    if first < 0:
        return {"status": "missing", "count": 0}
    count = text.count(find)
    if count > 1:
        return {"status": "ambiguous", "count": count}
    for at, node, start, run in placed:
        if at <= first and first + len(find) <= at + len(run):
            return {"status": "ok", "count": 1, "node": node, "start": start + first - at, "at": first}
    return {"status": "spans", "count": 1}


def locate_changes(text, placed, changes):
    """locate() for each change, plus "overlaps" for a change that shares text with an earlier one."""
    results, taken = [], []
    for change in changes:
        found = locate(text, placed, change["find"])
        if found["status"] == "ok":
            span = (found["at"], found["at"] + len(change["find"]))
            if any(span[0] < end and start < span[1] for start, end in taken):
                found = {"status": "overlaps", "count": 1}
            else:
                taken.append(span)
        results.append(found)
    return results


def public(found):
    """A locate() result as JSON: without the AT-SPI object."""
    return {"status": found["status"], "count": found["count"]}


def relocate(text, expected, at):
    """Where `expected` is in `text`: at `at` if it's still there, else its one other match, or None.

    For an insert (`expected` empty), `at` itself while it's within the text.
    """
    if not expected:
        return at if 0 <= at <= len(text) else None
    if text[at : at + len(expected)] == expected:
        return at
    first = text.find(expected)
    if first < 0 or text.find(expected, first + 1) >= 0:
        return None
    return first


def find_by_path(pid, path, role):
    """The object an edit target's path leads to in the app with that pid, if its role still matches."""
    desktop = Atspi.get_desktop(0)
    app = next((a for a in children(desktop) if safe(a.get_process_id) == pid), None)
    node = app
    for index in path:
        if node is None:
            return None
        node = safe(lambda: node.get_child_at_index(index))
    if node is None or (role and safe(node.get_role_name) != role):
        return None
    return node


def target_of(request):
    """The object a request's {"pid", "path", "role"} leads to, or None."""
    return find_by_path(int(request["pid"]), [int(i) for i in request["path"]], request.get("role"))


def span_in(iface, start, expected, whole=False):
    """Where `expected` is in a text now, as (start, end): see relocate(). With `whole`, the span is all of the
    text, which must still start with `expected` (a field's value as read, maybe cut short). None if it moved.
    """
    count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
    if whole:
        head = safe(lambda: Atspi.Text.get_text(iface, 0, len(expected)), None)
        return (0, count) if head == expected else None
    low = max(0, start - RELOCATE_CHARS)
    high = min(count, start + len(expected) + RELOCATE_CHARS)
    around = safe(lambda: Atspi.Text.get_text(iface, low, high), "") or ""
    at = relocate(around, expected, start - low)
    return None if at is None else (low + at, low + at + len(expected))


def apply_edit(request):
    """Replaces the target's `expected` text with `text` over AT-SPI, or inserts it at the caret.

    With "whole", it replaces all of the target's text (a form field), which must start with `expected`.
    """
    obj = target_of(request)
    if obj is None:
        return {"ok": False, "reason": "gone"}
    return write_at(obj, int(request["start"]), request["expected"], request["text"], bool(request.get("whole")))


def write_at(obj, start, expected, text, whole=False):
    """Replaces `expected` (near `start`) in obj's text with `text`, over AT-SPI.

    Inserts first and deletes after, so a write that fails leaves the original. Reasons for failing:
    "gone" (the object isn't there), "not_editable", "changed" (the original text isn't where it was),
    "failed" (the app refused the write).
    """
    iface = safe(obj.get_text_iface)
    editable = safe(obj.get_editable_text_iface)
    if iface is None or editable is None or not has_state(obj, Atspi.StateType.EDITABLE):
        return {"ok": False, "reason": "not_editable"}
    span = span_in(iface, start, expected, whole)
    if span is None:
        return {"ok": False, "reason": "changed"}
    start, end = span

    # insert_text's length is in bytes; anything at least as long as the text inserts all of it. Emptying a
    # field only deletes.
    if text and not safe(lambda: Atspi.EditableText.insert_text(editable, end, text, len(text.encode("utf-8"))), False):
        return {"ok": False, "reason": "failed"}
    if safe(lambda: Atspi.Text.get_text(iface, end, end + len(text)), None) != text:
        return {"ok": False, "reason": "failed"}
    if end > start and not safe(lambda: Atspi.EditableText.delete_text(editable, start, end), False):
        # Take the new text back out, so the original stands alone again.
        safe(lambda: Atspi.EditableText.delete_text(editable, end, end + len(text)))
        return {"ok": False, "reason": "failed"}
    return {"ok": True, "start": start, "end": start + len(text)}


def check_changes(request):
    """Whether each of request["changes"] can be found in the target: see locate_changes()."""
    obj = target_of(request)
    if obj is None:
        return {"ok": False, "reason": "gone"}
    text, placed = flatten(obj)
    return {"ok": True, "results": [public(found) for found in locate_changes(text, placed, request["changes"])]}


def apply_changes(request):
    """Writes every change over AT-SPI, or none when one can't be found (reason "changed").

    Goes from the last change to the first, so the earlier ones stay where they were found. "applied" lists
    the indices written, also when a write fails part of the way through.
    """
    obj = target_of(request)
    if obj is None:
        return {"ok": False, "reason": "gone"}
    changes = request["changes"]
    text, placed = flatten(obj)
    found = locate_changes(text, placed, changes)
    if any(item["status"] != "ok" for item in found):
        return {"ok": False, "reason": "changed", "applied": [], "results": [public(item) for item in found]}
    applied = []
    for index in sorted(range(len(changes)), key=lambda i: found[i]["at"], reverse=True):
        item, change = found[index], changes[index]
        result = write_at(item["node"], item["start"], change["find"], change["replace"])
        if not result["ok"]:
            return {"ok": False, "reason": result["reason"], "applied": applied}
        applied.append(index)
    return {"ok": True, "applied": applied}


def wait_for(check, seconds=1.5):
    """Polls `check` until it's true or time runs out: Firefox applies selections and clicks a moment later."""
    deadline = time.monotonic() + seconds
    while True:
        if check():
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(0.05)


def select_span(request):
    """Selects text in the target, for a paste over it: the one place `find` is (in rich text, inside the line
    holding it), or `expected` near `start` (an edit target), or all of it. An empty span puts the caret there.

    Returns {"ok", "path", "role", "start"}: the object holding the selection, for --verify after the paste.
    """
    root = target_of(request)
    if root is None:
        return {"ok": False, "reason": "gone"}
    node = root
    if "find" in request:
        text, placed = flatten(root)
        found = locate(text, placed, request["find"])
        if found["status"] != "ok":
            return {"ok": False, "reason": found["status"], "count": found["count"]}
        node, start, end = found["node"], found["start"], found["start"] + len(request["find"])
    else:
        iface = safe(root.get_text_iface)
        if iface is None:
            return {"ok": False, "reason": "not_text"}
        span = span_in(iface, int(request.get("start", 0)), request.get("expected", ""), bool(request.get("all")))
        if span is None:
            return {"ok": False, "reason": "changed"}
        start, end = span
    iface = safe(node.get_text_iface)
    if node is not root:
        # A line of rich text can't take focus itself: its editor (the compose box) has to have it.
        safe(lambda: Atspi.Component.grab_focus(root.get_component_iface()))
    if end > start:
        if not safe(lambda: Atspi.Text.set_selection(iface, 0, start, end), False):
            safe(lambda: Atspi.Text.add_selection(iface, start, end))
        selected = lambda: selected_span(iface) == (start, end)  # noqa: E731
    else:
        safe(lambda: Atspi.Text.set_caret_offset(iface, start))
        selected = lambda: safe(lambda: Atspi.Text.get_caret_offset(iface)) == start  # noqa: E731
    if not wait_for(selected):
        return {"ok": False, "reason": "not_selected"}
    path = path_from_app(node)
    return {"ok": True, "path": path, "role": safe(node.get_role_name), "start": start}


def verify_text(request):
    """Whether request["text"] is at request["start"] in the target now: a paste went in where it should."""
    obj = target_of(request)
    iface = safe(obj.get_text_iface) if obj is not None else None
    if iface is None:
        return {"ok": False, "reason": "gone"}
    start, text = int(request["start"]), request["text"]
    there = lambda: safe(lambda: Atspi.Text.get_text(iface, start, start + len(text))) == text  # noqa: E731
    return {"ok": True} if wait_for(there) else {"ok": False, "reason": "not_there"}


ACTION_NAMES = ("click", "press", "jump", "toggle", "activate", "check", "uncheck")


def press_check(request):
    """The control a press request leads to and its Action interface, or a reason it can't be pressed.

    With "name" (a control from a screen read), the control there must still say the same: a feed that loaded
    more posts can have put another one at its path.
    """
    obj = target_of(request)
    if obj is None:
        return None, None, "gone"
    if request.get("name") and control_label(obj) != request["name"]:
        return None, None, "moved"
    action = safe(obj.get_action_iface)
    if action is None or not (safe(lambda: Atspi.Action.get_n_actions(action), 0) or 0):
        return None, None, "no_action"
    return obj, action, None


def check_presses(request):
    """Whether each control in request["controls"] can still be pressed: "ok", "gone", "moved" or "no_action"."""
    pid = request["pid"]
    results = []
    for control in request["controls"]:
        _obj, _action, reason = press_check({**control, "pid": pid})
        results.append(reason or "ok")
    return {"ok": True, "results": results}


def press(request):
    """Clicks the target (a check box, radio button, button or link) through its action.

    With "checked", only when its state differs, and it checks the state changed.
    """
    obj, action, reason = press_check(request)
    if reason:
        return {"ok": False, "reason": reason}
    want = request.get("checked")
    is_checked = lambda: has_state(obj, Atspi.StateType.CHECKED)  # noqa: E731
    if want is not None and is_checked() == want:
        return {"ok": True, "changed": False}
    names = [(safe(lambda: Atspi.Action.get_action_name(action, i)) or "").lower() for i in range(safe(lambda: Atspi.Action.get_n_actions(action), 0) or 0)]
    index = next((i for i, name in enumerate(names) if name in ACTION_NAMES), 0 if names else None)
    if index is None or not safe(lambda: Atspi.Action.do_action(action, index), False):
        return {"ok": False, "reason": "failed"}
    if want is not None and not wait_for(lambda: is_checked() == want):
        return {"ok": False, "reason": "failed"}
    return {"ok": True, "changed": True}


def find_source(pid, window_path):
    """The app with `pid` and its window an earlier read found (its child index), or the one showing a page
    when that index no longer leads to a window. (None, None) when the app is gone.
    """
    app = next((a for a in children(Atspi.get_desktop(0)) if safe(a.get_process_id) == pid), None)
    if app is None:
        return None, None
    window = app
    for index in window_path or []:
        window = safe(lambda: window.get_child_at_index(index)) if window is not None else None
    if window is None or window is app or safe(window.get_role) not in WINDOW_ROLES:
        showing = [w for w in children(app) if has_state(w, Atspi.StateType.SHOWING)]
        window = next((w for w in showing if find_document(w) is not None), showing[0] if showing else None)
    return app, window


def read_screen(app, window, max_chars=150_000, max_seconds=3):
    """What's on screen in the window now: its title, its text on screen with markers where controls are
    (see control_marker()), those controls and the form fields on screen, with paths from the app.
    """
    budget = Budget(max_chars, max_seconds, max_nodes=20_000)
    budget.screen_only = True
    budget.controls = []
    document = find_document(window)
    root = document or window
    text = normalize(collect(root, budget))
    result = {"windowTitle": safe(window.get_name), "text": text, "truncated": budget.exhausted(), "controls": [], "fields": []}
    url = document_url(document) if document is not None else None
    if url:
        result["url"] = url
    base = path_from_app(root)
    if base is not None:
        result["controls"] = [{**control, "path": base + control["path"]} for control in budget.controls]
        result["fields"] = [{**field, "path": base + field["path"]} for field in budget.fields]
    else:
        # Controls Kiki can't find again can't be pressed: only their labels stay.
        result["text"] = re.sub(f"{CONTROL_START}\\d+{CONTROL_LABEL}([^{CONTROL_END}]*){CONTROL_END}", r"\1", text)
    return result


def screen(request):
    """read_screen() for the window an earlier read found."""
    app, window = find_source(int(request["pid"]), request.get("window"))
    if window is None:
        return {"ok": False, "reason": "gone"}
    return {"ok": True, **read_screen(app, window)}


def text_nodes(root, budget, depth=0, out=None):
    """The objects under root with text of their own, in reading order: (node, own text, showing)."""
    out = [] if out is None else out
    if budget.exhausted() or depth > 60:
        return out
    budget.nodes_left -= 1
    role = safe(root.get_role)
    if role in SKIP_ROLES or not is_visible(root):
        return out
    iface = safe(root.get_text_iface)
    if iface is not None:
        count = safe(lambda: Atspi.Text.get_character_count(iface), 0) or 0
        own = (safe(lambda: Atspi.Text.get_text(iface, 0, min(count, 20_000)), "") or "").replace(EMBEDDED_OBJECT, " ")
        if own.strip():
            out.append((root, own, has_state(root, Atspi.StateType.SHOWING)))
    for child in children(root):
        text_nodes(child, budget, depth + 1, out)
    return out


def squash(text):
    return " ".join(text.split()).casefold()


def find_text(nodes, wanted):
    """The node whose own text holds `wanted` (ignoring case and spacing) nearest what's on screen, or None.

    Falls back to the passage's first words: it may run on into a link, which is a node of its own.
    """
    shown = [index for index, (_node, _text, showing) in enumerate(nodes) if showing]
    words = squash(wanted).split()
    for count in (len(words), 8, 5, 3):
        if count > len(words) or count < min(3, len(words)):
            continue
        needle = " ".join(words[:count])
        matches = [index for index, (_node, text, _showing) in enumerate(nodes) if needle in squash(text)]
        if matches:
            near = lambda index: min((abs(index - s) for s in shown), default=0)  # noqa: E731
            return nodes[min(matches, key=near)][0]
    return None


def top_of(node):
    """Where node's top is in its window now, or None."""
    component = safe(node.get_component_iface)
    extents = safe(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.WINDOW)) if component else None
    return (extents.x, extents.y) if extents is not None and extents.height > 0 else None


def scroll_node(node, y=None, edge=None):
    """Scrolls the page so node's top is at `y` in the window, or node sits at `edge`. Whether it moved."""
    component = safe(node.get_component_iface)
    before = top_of(node)
    if component is None or before is None:
        return False
    if edge is not None:
        asked = safe(lambda: Atspi.Component.scroll_to(component, edge), False)
    else:
        asked = safe(lambda: Atspi.Component.scroll_to_point(component, Atspi.CoordType.WINDOW, before[0], y), False)
        if not asked:
            asked = safe(lambda: Atspi.Component.scroll_to(component, Atspi.ScrollType.TOP_EDGE), False)
    return bool(asked) and wait_for(lambda: top_of(node) != before, 1.0)


def screen_step(root, direction):
    """Scrolls a page by about a screen over AT-SPI: the last line on screen to near the top, or the first to
    the bottom. It goes by the longest run of text on screen, which leaves sticky headers and sidebars out.
    """
    nodes = text_nodes(root, Budget(400_000, 2, max_nodes=20_000))
    runs, current = [], []
    for node, text, showing in nodes:
        if showing:
            current.append((node, len(text)))
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    if not runs:
        return False
    run = max(runs, key=lambda r: sum(length for _node, length in r))
    if direction == "down":
        return scroll_node(run[-1][0], y=NEXT_SCREEN_Y)
    return scroll_node(run[0][0], edge=Atspi.ScrollType.BOTTOM_EDGE)


def scroll(request):
    """Scrolls a page in the window an earlier read found, over AT-SPI, then reads the screen: a screen
    (direction "down" or "up"), or until the text "to" is near the top. Firefox only scrolls a window that's
    on screen, not one hidden behind others.

    Returns read_screen() plus "moved", or {"ok": false, "reason"}: "gone", "not_found" (no such text), or
    "not_moved" (the app didn't scroll; "y" says where the text is, for scrolling another way).
    """
    app, window = find_source(int(request["pid"]), request.get("window"))
    if window is None:
        return {"ok": False, "reason": "gone"}
    root = find_document(window) or window
    if "to" in request:
        node = find_text(text_nodes(root, Budget(400_000, 3, max_nodes=30_000)), request["to"])
        if node is None:
            return {"ok": False, "reason": "not_found"}
        if not scroll_node(node, y=SCROLL_TO_Y):
            # Already where it should be, or the app doesn't scroll over AT-SPI.
            at = top_of(node)
            if not has_state(node, Atspi.StateType.SHOWING) or at is None or at[1] < 0:
                return {"ok": False, "reason": "not_moved", **({"y": at[1]} if at else {})}
        moved = True
    else:
        moved = screen_step(root, request.get("direction", "down"))
    return {"ok": True, "moved": moved, **read_screen(app, window)}


COUNT_PATTERN = re.compile(r"\b(\d+)\s+of\s+(\d+)\b|\bno results\b", re.IGNORECASE)


def docs_dialog(request):
    """Google Docs' "Find and replace" dialog in the app with request["pid"], once it shows (up to "wait"
    seconds): its text fields, check boxes and buttons with their paths, and the "N of M" match count.
    """
    pid = int(request["pid"])
    deadline = time.monotonic() + float(request.get("wait", 2))
    while True:
        app = next((a for a in children(Atspi.get_desktop(0)) if safe(a.get_process_id) == pid), None)
        dialog = find_docs_dialog(app) if app is not None else None
        if dialog is not None:
            return {"ok": True, **dialog_parts(dialog)}
        if time.monotonic() > deadline:
            return {"ok": False, "reason": "no_dialog" if app is not None else "gone"}
        time.sleep(0.1)


def find_docs_dialog(app):
    """The showing dialog whose name mentions "replace", in the app's active web document."""
    for window in children(app):
        document = find_document(window)
        if document is None or not has_state(document, Atspi.StateType.SHOWING):
            continue
        found = []

        def walk(node, depth):
            if found or depth > 40:
                return
            if safe(node.get_role) in (Atspi.Role.DIALOG, Atspi.Role.ALERT) and has_state(node, Atspi.StateType.SHOWING):
                if "replace" in (safe(node.get_name) or "").lower():
                    found.append(node)
                    return
            for child in children(node):
                walk(child, depth + 1)

        walk(document, 0)
        if found:
            return found[0]
    return None


def dialog_parts(dialog):
    """The fields, check boxes, buttons and match count in a dialog, in reading order."""
    parts = {"fields": [], "checks": [], "buttons": [], "count": None}

    def walk(node, depth):
        if depth > 30 or not is_visible(node):
            return
        role = safe(node.get_role)
        name = " ".join((safe(node.get_name) or "").split())
        if role in (Atspi.Role.ENTRY, Atspi.Role.TEXT) and has_state(node, Atspi.StateType.EDITABLE):
            iface = safe(node.get_text_iface)
            text = safe(lambda: Atspi.Text.get_text(iface, 0, 500), "") if iface else ""
            parts["fields"].append({"path": path_from_app(node), "role": safe(node.get_role_name), "name": name, "text": text})
            return
        if role in TOGGLE_ROLES:
            parts["checks"].append(
                {"path": path_from_app(node), "role": safe(node.get_role_name), "name": name, "checked": has_state(node, Atspi.StateType.CHECKED)}
            )
            return
        if role in (Atspi.Role.PUSH_BUTTON, Atspi.Role.BUTTON):
            parts["buttons"].append({"path": path_from_app(node), "role": safe(node.get_role_name), "name": name})
            return
        if parts["count"] is None:
            iface = safe(node.get_text_iface)
            own = (safe(lambda: Atspi.Text.get_text(iface, 0, 200), "") or "") if iface else ""
            for candidate in (own.replace(EMBEDDED_OBJECT, " "), name):
                match = COUNT_PATTERN.search(candidate)
                if match:
                    parts["count"] = match.group(0)
                    break
        for child in children(node):
            walk(child, depth + 1)

    walk(dialog, 0)
    return parts


def take_screenshot(timeout_seconds=10):
    """Non-interactive screenshot through org.freedesktop.portal.Screenshot."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = "kiki" + secrets.token_hex(8)
    sender = bus.get_unique_name()[1:].replace(".", "_")
    handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    loop = GLib.MainLoop()
    result = {"ok": False, "error": "timed out waiting for the screenshot portal"}

    def on_response(_conn, _sender, _path, _iface, _signal, params):
        code, results = params.unpack()
        if code == 0 and results.get("uri"):
            result.clear()
            result.update({"ok": True, "uri": results["uri"]})
        else:
            result.update({"error": "screenshot was cancelled or denied" if code else "no image returned"})
        loop.quit()

    subscription = bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        handle,
        None,
        Gio.DBusSignalFlags.NO_MATCH_RULE,
        on_response,
    )
    try:
        bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            GLib.Variant(
                "(sa{sv})",
                ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)}),
            ),
            None,
            Gio.DBusCallFlags.NONE,
            timeout_seconds * 1000,
            None,
        )
        GLib.timeout_add_seconds(timeout_seconds, loop.quit)
        loop.run()
    finally:
        bus.signal_unsubscribe(subscription)

    if result.get("ok"):
        result["path"] = Gio.File.new_for_uri(result.pop("uri")).get_path()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--screenshot", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--edit", metavar="JSON")
    parser.add_argument("--check-changes", metavar="JSON")
    parser.add_argument("--apply-changes", metavar="JSON")
    parser.add_argument("--select", metavar="JSON")
    parser.add_argument("--verify", metavar="JSON")
    parser.add_argument("--press", metavar="JSON")
    parser.add_argument("--check-presses", metavar="JSON")
    parser.add_argument("--screen", metavar="JSON")
    parser.add_argument("--scroll", metavar="JSON")
    parser.add_argument("--docs-dialog", metavar="JSON")
    parser.add_argument("--delay", type=float, default=0)
    parser.add_argument("--max-chars", type=int, default=150_000)
    parser.add_argument("--max-seconds", type=float, default=0.8)
    args = parser.parse_args()
    if args.delay:
        time.sleep(args.delay)
    try:
        if args.check:
            output = {"ok": True}
        elif args.screenshot:
            output = take_screenshot()
        elif args.edit:
            output = apply_edit(json.loads(args.edit))
        elif args.check_changes:
            output = check_changes(json.loads(args.check_changes))
        elif args.apply_changes:
            output = apply_changes(json.loads(args.apply_changes))
        elif args.select:
            output = select_span(json.loads(args.select))
        elif args.verify:
            output = verify_text(json.loads(args.verify))
        elif args.press:
            output = press(json.loads(args.press))
        elif args.check_presses:
            output = check_presses(json.loads(args.check_presses))
        elif args.screen:
            output = screen(json.loads(args.screen))
        elif args.scroll:
            output = scroll(json.loads(args.scroll))
        elif args.docs_dialog:
            output = docs_dialog(json.loads(args.docs_dialog))
        else:
            output = capture_context(args.max_chars, args.max_seconds)
    except Exception as error:  # Report instead of crashing; the app falls back gracefully.
        output = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
