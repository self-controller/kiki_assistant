#!/usr/bin/python3
"""Reads the harness's Electron window with Kiki's helper, as Kiki would read Chrome. Prints one JSON object.

  check.py read PID    What the quick and full reads find, and the document's attributes
  check.py write PID   Whether the helper's --select selects in the page's textarea, and AT-SPI's insert_text writes
  check.py dump PID    The page's accessibility tree: role, name, own text and a few states per node
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "resources"))
import kiki_context as k  # noqa: E402
from gi.repository import Atspi  # noqa: E402


def app_and_window(pid, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        for app in k.children(Atspi.get_desktop(0)):
            if k.safe(app.get_process_id) == pid:
                for window in k.children(app):
                    if k.safe(window.get_role) == Atspi.Role.FRAME and k.find_document(window) is not None:
                        return app, window
        time.sleep(0.2)
    return None, None


def find(node, test, depth=0):
    if depth > 40:
        return None
    if test(node):
        return node
    for child in k.children(node):
        found = find(child, test, depth + 1)
        if found is not None:
            return found
    return None


def read(pid):
    started = time.time()
    app, window = app_and_window(pid)
    if window is None:
        return {"ok": False, "error": "the harness window isn't on AT-SPI"}
    found_ms = round((time.time() - started) * 1000)
    document = k.find_document(window)
    iface = k.safe(document.get_document_iface)
    attributes = k.safe(lambda: Atspi.Document.get_document_attributes(iface)) if iface else None
    started = time.time()
    quick = k.read_window(app, window, 150_000, 0.2, cursor=True, page=False)
    quick_ms = round((time.time() - started) * 1000)
    started = time.time()
    full = k.read_window(app, window, 150_000, 5, cursor=False, page=True)
    full_ms = round((time.time() - started) * 1000)
    keep = ("appName", "toolkit", "windowTitle", "url", "pageTitle", "pageSelected", "source", "hasText", "selection")
    return {
        "ok": True,
        "foundMs": found_ms,
        "attributes": dict(attributes or {}),
        "documentName": k.safe(document.get_name),
        "quick": {key: quick.get(key) for key in keep if key in quick} | {"ms": quick_ms},
        "full": {key: full.get(key) for key in keep if key in full}
        | {"ms": full_ms, "text": full.get("text", "")[:300], "fields": len(full.get("fields") or [])},
    }


def write(pid):
    app, window = app_and_window(pid)
    if window is None:
        return {"ok": False, "error": "the harness window isn't on AT-SPI"}
    notes = find(
        window,
        lambda node: k.safe(node.get_role) in k.TEXT_FIELD_ROLES and k.has_state(node, Atspi.StateType.MULTI_LINE),
    )
    if notes is None:
        return {"ok": False, "error": "no textarea"}
    # What Kiki's select+paste does first: select the text to paste over, with the helper's own --select.
    request = {"pid": pid, "path": k.path_from_app(notes), "role": k.safe(notes.get_role_name), "start": 0, "expected": "teh"}
    selected = k.select_span(request)
    editable = k.safe(notes.get_editable_text_iface)
    if editable is None:
        # Kiki selects the text and pastes over it there instead (SELECT_PASTE_TOOLKITS).
        return {"ok": True, "select": selected, "editableText": False}
    text = notes.get_text_iface()
    returned = k.safe(lambda: Atspi.EditableText.insert_text(editable, 0, "KIKI ", len("KIKI ".encode())))
    time.sleep(0.3)
    after = k.safe(lambda: Atspi.Text.get_text(text, 0, Atspi.Text.get_character_count(text)))
    return {"ok": True, "select": selected, "editableText": True, "insertReturned": returned, "textAfter": after}


def dump(pid):
    app, window = app_and_window(pid)
    if window is None:
        return {"ok": False, "error": "the harness window isn't on AT-SPI"}
    lines = []

    def walk(node, depth):
        if depth > 30 or len(lines) > 400:
            return
        iface = k.safe(node.get_text_iface)
        count = k.safe(lambda: Atspi.Text.get_character_count(iface), 0) if iface else None
        text = k.safe(lambda: Atspi.Text.get_text(iface, 0, count), "") if count else ""
        states = [name for name, state in (("showing", Atspi.StateType.SHOWING), ("editable", Atspi.StateType.EDITABLE),
                                            ("multi", Atspi.StateType.MULTI_LINE), ("enabled", Atspi.StateType.ENABLED))
                  if k.has_state(node, state)]
        lines.append(f"{'  ' * depth}{k.safe(node.get_role_name)} name={k.safe(node.get_name)!r} "
                     f"text={text[:70]!r} count={count} kids={k.safe(node.get_child_count)} {' '.join(states)}")
        for child in k.children(node):
            walk(child, depth + 1)

    walk(k.find_document(window), 0)
    return {"ok": True, "tree": lines}


if __name__ == "__main__":
    step, pid = sys.argv[1], int(sys.argv[2])
    print(json.dumps({"read": read, "write": write, "dump": dump}[step](pid), default=str))
