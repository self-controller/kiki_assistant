#!/usr/bin/python3
"""Kiki's Linux context helper. Prints one JSON object to stdout.

  kiki_context.py              Active app, window title and visible text via AT-SPI
                               (terminals and editors: only the text around the selection or caret)
  kiki_context.py --screenshot Full-screen screenshot via the XDG desktop portal
  kiki_context.py --delay 3    Wait first (for testing: highlight text, then switch windows)
  kiki_context.py --check      Exit successfully if AT-SPI is importable

Must run under the system Python (with PyGObject), e.g. /usr/bin/python3.
"""

import argparse
import json
import secrets
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib  # noqa: E402

EMBEDDED_OBJECT = "￼"
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
DOCUMENT_ROLES = {Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME}
# Text where only the lines around the selection or caret matter: terminals and multi-line editors.
EDITOR_ROLES = {Atspi.Role.TEXT, Atspi.Role.DOCUMENT_TEXT, Atspi.Role.ENTRY}
# How much to read on each side of the selection or caret; Kiki trims it to whole lines.
VICINITY_BEFORE = 16_000
VICINITY_AFTER = 8_000


class Budget:
    def __init__(self, max_chars, max_seconds, max_nodes):
        self.chars_left = max_chars
        self.deadline = time.monotonic() + max_seconds
        self.nodes_left = max_nodes
        # Selected text found along the way, in reading order.
        self.selections = []

    def exhausted(self):
        return self.chars_left <= 0 or self.nodes_left <= 0 or time.monotonic() > self.deadline


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # AT-SPI calls fail freely when apps change or hang.
        return default


def children(obj):
    count = safe(obj.get_child_count, 0) or 0
    for index in range(min(count, 500)):
        child = safe(lambda: obj.get_child_at_index(index))
        if child is not None:
            yield child


def is_visible(obj):
    states = safe(obj.get_state_set)
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


def collect(obj, budget, depth=0):
    """Reading-order text for obj's subtree, stopping when the budget runs out."""
    if budget.exhausted() or depth > 60:
        return ""
    budget.nodes_left -= 1
    role = safe(obj.get_role)
    if role in SKIP_ROLES or not is_visible(obj):
        return ""

    text = own_text(obj, budget)
    if text is None:
        # No text of its own: join the children's text.
        parts = []
        for child in children(obj):
            part = collect(child, budget, depth + 1)
            if part.strip():
                parts.append(part)
            if budget.exhausted():
                break
        joined = "\n".join(parts)
    elif EMBEDDED_OBJECT in text:
        # Hypertext: each U+FFFC stands for the next child (a link, an inline element...).
        pieces = text.split(EMBEDDED_OBJECT)
        out = [pieces[0]]
        kids = list(children(obj))
        for index, piece in enumerate(pieces[1:]):
            if index < len(kids) and not budget.exhausted():
                child_role = safe(kids[index].get_role)
                child_text = collect(kids[index], budget, depth + 1)
                out.append(("\n" + child_text + "\n") if child_role in BLOCK_ROLES else child_text)
            out.append(piece)
        joined = "".join(out)
    else:
        joined = text

    budget.chars_left -= len(joined)
    return joined


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


def find_anchor(obj, budget, found, depth=0):
    """Looks for the text object holding the selection, noting the first focused one on the way.

    Reads no text. Skips web documents: pages go through collect(), which reads around the selection.
    """
    if budget.exhausted() or depth > 60:
        return
    budget.nodes_left -= 1
    role = safe(obj.get_role)
    if role in SKIP_ROLES or role in DOCUMENT_ROLES or not is_visible(obj):
        return
    iface = safe(obj.get_text_iface)
    # Hidden tabs are "visible" but not "showing"; their stale selections don't count.
    if iface is not None and has_state(obj, Atspi.StateType.SHOWING):
        span = selected_span(iface)
        if span is not None:
            found["selected"] = (obj, iface, span)
            return
        if "focused" not in found and has_state(obj, Atspi.StateType.FOCUSED):
            found["focused"] = (obj, iface)
    for child in children(obj):
        find_anchor(child, budget, found, depth + 1)
        if "selected" in found or budget.exhausted():
            return


def read_vicinity(window, max_seconds):
    """The text around the selection (or the caret) of a terminal or editor in window, or None.

    Returns {"kind", "before", "anchor", "after"}: "anchor" is the selected text ("" at a caret), and
    "before"/"after" are up to VICINITY_BEFORE/AFTER characters on either side, unnormalized so that
    indentation and columns survive.
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

    names = {"ok": True, "appName": safe(app.get_name), "windowTitle": safe(window.get_name)}
    vicinity = read_vicinity(window, max_seconds / 2)
    if vicinity is not None:
        return {**names, "text": "", "selection": vicinity["anchor"], "source": vicinity["kind"], "vicinity": vicinity}

    budget = Budget(max_chars, max_seconds, max_nodes=20_000)
    document = find_document(window)
    text = normalize(collect(document or window, budget))
    return {
        **names,
        "text": text,
        "selection": normalize("\n".join(budget.selections)),
        "source": "document" if document is not None else "window",
        "truncated": budget.exhausted(),
    }


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
        else:
            output = capture_context(args.max_chars, args.max_seconds)
    except Exception as error:  # Report instead of crashing; the app falls back gracefully.
        output = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
