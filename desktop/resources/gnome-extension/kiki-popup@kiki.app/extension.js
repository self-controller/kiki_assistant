// Kiki's GNOME Shell helper. Apps can't place their own windows on Wayland, so this opens Kiki's
// popup with its chat box at the pointer, and focuses it. Right before it shows a popup, Kiki calls
// PlacePopup over D-Bus to learn the window's size and where the chat box sits in it.
// When the hotkey is pressed, Kiki calls RememberSource; CaptureSource then takes a screenshot of that
// window around the pointer, from the window's own pixels, so Kiki's popup on top of it doesn't show.
// PasteToSource focuses that window again and types the paste shortcut, for Kiki's edit cards in apps
// that don't take text over accessibility. FocusSource only focuses it (Kiki then selects the text a change
// replaces, over accessibility, and pastes), and KeysToSource presses a few allowed shortcuts there, such as
// Ctrl+H for Google Docs' Find and replace. ScrollSource scrolls it with a virtual mouse wheel, without taking
// the focus from Kiki, for Kiki's scroll tool. SetClipboard puts text on the clipboard for those pastes: GNOME
// drops a clipboard write from an app without the keyboard, and Kiki hands the keyboard to that window.
// ActivatePopup gives the open popup the keyboard again, when the hotkey brings a new highlight into it.
// SourceApp says which app the remembered window belongs to, for apps that share nothing over accessibility.
// KeysToSource also presses Ctrl+Z, and Backspace many times over, for Kiki's Undo button (v12).
// Version 13: ListWindows and SelectSource let Kiki work in another window than the hotkey's; ListApps and
// LaunchApp start apps; ClickAt, DragPath and KeyChord click, drag and press key chords in the source window
// (raising it first when something covers the spot); ShowBanner and HideBanner show "Kiki is using your
// computer" with a Stop button, and Esc stops too (see banner.js).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Banner} from './banner.js';
import {cropAround} from './crop.js';
import {insideHitRect, popupGeometry} from './placement.js';
import {inside, scrollPoint} from './scroll.js';

Gio._promisify(Shell.Screenshot, 'composite_to_stream');

const VERSION = 13;
const OBJECT_PATH = '/app/kiki/Shell';
/** How long after PlacePopup the next window from that process counts as the popup. */
const EXPECT_US = 5 * GLib.USEC_PER_SEC;

const INTERFACE = `<node>
  <interface name="app.kiki.Shell">
    <method name="PlacePopup">
      <arg type="u" direction="in" name="pid"/>
      <arg type="i" direction="in" name="cardHeight"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
      <arg type="i" direction="out" name="anchorY"/>
    </method>
    <method name="MovePopup">
      <arg type="u" direction="in" name="pid"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="moving"/>
    </method>
    <method name="ActivatePopup">
      <arg type="u" direction="in" name="pid"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="found"/>
    </method>
    <method name="SetHitRect">
      <arg type="u" direction="in" name="pid"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="found"/>
    </method>
    <method name="RememberSource">
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="found"/>
    </method>
    <method name="SourceApp">
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="app"/>
    </method>
    <method name="CaptureSource">
      <arg type="i" direction="in" name="maxWidth"/>
      <arg type="i" direction="in" name="maxHeight"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="path"/>
    </method>
    <method name="PasteToSource">
      <arg type="b" direction="in" name="terminal"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="pasted"/>
    </method>
    <method name="FocusSource">
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="focused"/>
    </method>
    <method name="KeysToSource">
      <arg type="as" direction="in" name="steps"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="done"/>
    </method>
    <method name="SetClipboard">
      <arg type="s" direction="in" name="text"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="done"/>
    </method>
    <method name="ScrollSource">
      <arg type="i" direction="in" name="percent"/>
      <arg type="i" direction="in" name="pixels"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="outcome"/>
    </method>
    <method name="ListWindows">
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="windows"/>
    </method>
    <method name="SelectSource">
      <arg type="s" direction="in" name="id"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="found"/>
    </method>
    <method name="ListApps">
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="apps"/>
    </method>
    <method name="LaunchApp">
      <arg type="s" direction="in" name="id"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="started"/>
    </method>
    <method name="ClickAt">
      <arg type="d" direction="in" name="x"/>
      <arg type="d" direction="in" name="y"/>
      <arg type="s" direction="in" name="button"/>
      <arg type="i" direction="in" name="count"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="outcome"/>
    </method>
    <method name="DragPath">
      <arg type="ad" direction="in" name="points"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="outcome"/>
    </method>
    <method name="KeyChord">
      <arg type="s" direction="in" name="chord"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="done"/>
    </method>
    <method name="ShowBanner">
      <arg type="s" direction="in" name="text"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="shown"/>
    </method>
    <method name="HideBanner">
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="hidden"/>
    </method>
    <method name="Version">
      <arg type="u" direction="out" name="version"/>
    </method>
  </interface>
</node>`;

/** How often a popup that lets clicks through checks the pointer, besides when the cursor tracker says it moved. */
const POINTER_POLL_MS = 100;

/** Longest text SetClipboard takes, in characters. */
const MAX_CLIPBOARD = 1_000_000;

/** Largest crop CaptureSource takes, in logical pixels. */
const MAX_CROP = 4096;
/** How long PasteToSource waits for the source window to take focus. */
const FOCUS_WAIT_MS = 500;
/** Time for the focused app to see the focus change before the keys arrive, and between keys. */
const KEY_SETTLE_MS = 60;
const KEY_GAP_MS = 15;
/** Time for the app to act on one shortcut (open a dialog, move the cursor) before the next. */
const STEP_GAP_MS = 120;

/** Mutter hands apps 10 pixels for each 1.0 of a smooth scroll. */
const PIXELS_PER_SCROLL = 10;
/** ScrollSource scrolls in pieces this big, this far apart, like a quick flick on a touchpad. */
const SCROLL_PIECE_PX = 80;
const SCROLL_GAP_MS = 10;
/** Time for the window to see the pointer arrive before the scroll does. */
const POINTER_SETTLE_MS = 40;
/** Pause before the scroll's end, so apps see it stopped and don't carry it on (kinetic scrolling). */
const SCROLL_STOP_MS = 150;
/** The most one ScrollSource moves: about ten screens. */
const MAX_SCROLL_PX = 20000;

/**
 * The shortcuts KeysToSource presses, by name. Only these: whatever calls it can't type text, which goes
 * through the clipboard and a paste instead. A step may also be 'backspace*N' (N up to MAX_REPEAT): Backspace
 * pressed N times, quickly, which takes back text Kiki pasted at a terminal's prompt.
 */
const KEY_STEPS = {
    'ctrl+a': [Clutter.KEY_Control_L, Clutter.KEY_a],
    'ctrl+f': [Clutter.KEY_Control_L, Clutter.KEY_f],
    'ctrl+h': [Clutter.KEY_Control_L, Clutter.KEY_h],
    'ctrl+v': [Clutter.KEY_Control_L, Clutter.KEY_v],
    'ctrl+shift+v': [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v],
    'ctrl+z': [Clutter.KEY_Control_L, Clutter.KEY_z],
    'backspace': [Clutter.KEY_BackSpace],
    'escape': [Clutter.KEY_Escape],
    'enter': [Clutter.KEY_Return],
    'tab': [Clutter.KEY_Tab],
};
const REPEAT_STEP = /^backspace\*(\d{1,4})$/;
const MAX_REPEAT = 2000;

/** The keys KeyChord presses, by name, with ctrl, alt and shift. Letters and digits too; never text. */
const CHORD_KEYS = {
    enter: Clutter.KEY_Return,
    return: Clutter.KEY_Return,
    tab: Clutter.KEY_Tab,
    escape: Clutter.KEY_Escape,
    esc: Clutter.KEY_Escape,
    backspace: Clutter.KEY_BackSpace,
    delete: Clutter.KEY_Delete,
    up: Clutter.KEY_Up,
    down: Clutter.KEY_Down,
    left: Clutter.KEY_Left,
    right: Clutter.KEY_Right,
    home: Clutter.KEY_Home,
    end: Clutter.KEY_End,
    pageup: Clutter.KEY_Page_Up,
    pagedown: Clutter.KEY_Page_Down,
    space: Clutter.KEY_space,
    f1: Clutter.KEY_F1,
    f2: Clutter.KEY_F2,
    f3: Clutter.KEY_F3,
    f4: Clutter.KEY_F4,
    f5: Clutter.KEY_F5,
    f6: Clutter.KEY_F6,
    f7: Clutter.KEY_F7,
    f8: Clutter.KEY_F8,
    f9: Clutter.KEY_F9,
    f10: Clutter.KEY_F10,
    f11: Clutter.KEY_F11,
    f12: Clutter.KEY_F12,
};
const CHORD_MODIFIERS = {
    ctrl: Clutter.KEY_Control_L,
    control: Clutter.KEY_Control_L,
    alt: Clutter.KEY_Alt_L,
    shift: Clutter.KEY_Shift_L,
    super: Clutter.KEY_Super_L,
};

/** The keysyms of a chord like "ctrl+shift+a" or "pageup", modifiers first; null for anything else. */
function parseChord(chord) {
    const parts = String(chord).toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > 4)
        return null;
    const keys = [];
    for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(CHORD_MODIFIERS, part))
            return null;
        keys.push(CHORD_MODIFIERS[part]);
    }
    const last = parts.at(-1);
    if (Object.hasOwn(CHORD_KEYS, last))
        keys.push(CHORD_KEYS[last]);
    else if (/^[a-z0-9]$/.test(last))
        keys.push(Clutter.unicode_to_keysym(last.codePointAt(0)));
    else
        return null;
    return keys;
}

const BUTTONS = {
    left: Clutter.BUTTON_PRIMARY,
    middle: Clutter.BUTTON_MIDDLE,
    right: Clutter.BUTTON_SECONDARY,
};
/** Between a button's press and release, between clicks of a double click, and between the drag's steps. */
const CLICK_HOLD_MS = 40;
const CLICK_GAP_MS = 80;
const DRAG_STEP_MS = 12;
const DRAG_STEPS = 12;
/** How long ClickAt waits for a raised window to come to the top. */
const RAISE_WAIT_MS = 600;
/** The most windows ListWindows reports. */
const MAX_WINDOWS = 60;
/** Between the presses of a repeated key, and how many of them go by between checks that the window still has the keyboard. */
const REPEAT_GAP_MS = 3;
const REPEAT_CHECK_EVERY = 50;

/** The keys a step presses: a named shortcut, or [keys, count] for a repeated one. Null for a step Kiki doesn't press. */
function parseStep(step) {
    if (Object.hasOwn(KEY_STEPS, step))
        return {keys: KEY_STEPS[step], count: 1};
    const repeat = REPEAT_STEP.exec(step);
    const count = repeat ? Number(repeat[1]) : 0;
    return count >= 1 && count <= MAX_REPEAT ? {keys: KEY_STEPS['backspace'], count} : null;
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

/** Mutter 47+ lets the compositor set a new window's position before it first shows. */
const HAS_CONFIGURE = GObject.signal_lookup('configure', Meta.Window.$gtype) !== 0;

/** One popup window: placed where PlacePopup said as it opens, then focused. */
class Popup {
    constructor(window, position, onGone) {
        this._window = window;
        this._position = position;
        this._onGone = onGone;
        this._placed = false;
        this._shown = false;
        /** The chat box, in window coordinates; the rest of the window lets clicks through. Null: all of it. */
        this._hit = null;
        this._reactive = true;

        if (HAS_CONFIGURE)
            window.connectObject('configure', (_window, config) => this._configure(config), this);
        window.connectObject(
            'unmanaging', () => this._skipEffect(),
            'unmanaged', () => this.destroy(),
            this);

        this._actor = window.get_compositor_private();
        if (this._actor) {
            // The chat box fades in by itself; skip GNOME's zoom.
            Main.wm.skipNextEffect(this._actor);
            this._actor.connectObject(
                'first-frame', () => this._firstFrame(),
                'destroy', () => (this._actor = null),
                this);
        } else {
            window.connectObject('shown', () => this._firstFrame(), this);
        }
    }

    get window() {
        return this._window;
    }

    get hasHitRect() {
        return this._hit !== null;
    }

    /** Whether the popup takes the pointer at `point`: over its chat box, or anywhere without a hit rect. */
    takes(point) {
        return !this._hit || insideHitRect(point, rectOf(this._window.get_frame_rect()), this._hit);
    }

    setHitRect(rect) {
        this._hit = rect.width > 0 && rect.height > 0 ? rect : null;
        this.updatePointer();
    }

    /**
     * Takes clicks only while the pointer is over the chat box. Kiki stays open on top of other windows,
     * and most of its window is transparent space above the box: clicks there go to the window below.
     * Wayland apps set which part of a window takes input, but Electron doesn't, so this does it instead:
     * Mutter sends the pointer to the actor it picks, and it doesn't pick actors that aren't reactive.
     */
    updatePointer() {
        const [x, y] = global.get_pointer();
        const reactive = !this._hit || insideHitRect({x, y}, rectOf(this._window.get_frame_rect()), this._hit);
        if (reactive === this._reactive)
            return;
        this._reactive = reactive;
        const actor = this._window.get_compositor_private();
        if (actor) {
            setReactive(actor, reactive);
            // Mutter only picks again when something moves: without this, a click right after the pointer
            // jumped onto the box (or off it) would still go to the window it was over before.
            actor.queue_relayout();
        }
    }

    _configure(config) {
        if (this._placed || !config.get_is_initial())
            return;
        // Only set the position: on Mutter 50, config.get_rect() comes back null in JavaScript.
        try {
            config.set_position(this._position.x, this._position.y);
            this._placed = true;
        } catch (e) {
            console.warn(`Kiki: couldn't place the popup before it showed: ${e}`);
        }
    }

    _firstFrame() {
        if (this._shown)
            return;
        this._shown = true;
        this._actor?.disconnectObject(this);
        this._actor = null;
        // Not placed up front (older Mutter): move it now, while the chat box is still transparent.
        const rect = this._window.get_frame_rect();
        if (rect.x !== this._position.x || rect.y !== this._position.y)
            this._window.move_frame(true, this._position.x, this._position.y);
        this._window.make_above();
        Main.activateWindow(this._window);
    }

    _skipEffect() {
        const actor = this._window.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
    }

    destroy() {
        if (!this._reactive) {
            const actor = this._window.get_compositor_private();
            if (actor)
                setReactive(actor, true);
        }
        this._actor?.disconnectObject(this);
        this._actor = null;
        this._window.disconnectObject(this);
        this._onGone(this);
    }
}

export default class KikiExtension extends Extension {
    enable() {
        this._expected = new Map();
        this._popups = new Set();
        this._service = Gio.DBusExportedObject.wrapJSObject(INTERFACE, {
            PlacePopup: (pid, cardHeight) => this._place(pid, cardHeight),
            MovePopup: pid => [VERSION, this._move(pid)],
            ActivatePopup: pid => [VERSION, this._activate(pid)],
            SetHitRect: (pid, x, y, width, height) => [VERSION, this._setHitRect(pid, {x, y, width, height})],
            RememberSource: () => [VERSION, this._rememberSource()],
            SourceApp: () => [VERSION, this._sourceApp()],
            CaptureSourceAsync: (params, invocation) => this._captureSource(params, invocation),
            PasteToSourceAsync: (params, invocation) => this._pasteToSource(params, invocation),
            FocusSourceAsync: (params, invocation) => this._reply(invocation, () => this._focusSource()),
            KeysToSourceAsync: ([steps], invocation) => this._reply(invocation, () => this._keysToSource(steps)),
            ScrollSourceAsync: (params, invocation) => this._scrollSourceCall(params, invocation),
            SetClipboard: text => [VERSION, this._setClipboard(text)],
            ListWindows: () => [VERSION, this._listWindows()],
            SelectSource: id => [VERSION, this._selectSource(id)],
            ListApps: () => [VERSION, this._listApps()],
            LaunchApp: id => [VERSION, this._launchApp(id)],
            ClickAtAsync: (params, invocation) => this._outcomeCall(invocation, () => this._clickAt(...params)),
            DragPathAsync: ([points], invocation) => this._outcomeCall(invocation, () => this._dragPath(points)),
            KeyChordAsync: ([chord], invocation) => this._reply(invocation, () => this._keyChord(chord)),
            ShowBanner: text => [VERSION, this._banner.show(text)],
            HideBanner: () => [VERSION, this._banner.hide()],
            Version: () => VERSION,
        });
        this._service.export(Gio.DBus.session, OBJECT_PATH);
        global.display.connectObject('window-created', (_display, window) => this._windowCreated(window), this);
        this._cancelled = false;
        this._banner = new Banner(() => (this._cancelled = true));
    }

    disable() {
        this._banner?.destroy();
        this._banner = null;
        this._stopTracking();
        this._forgetSource();
        this._keyboard?.run_dispose();
        this._keyboard = null;
        this._pointer?.run_dispose();
        this._pointer = null;
        global.display.disconnectObject(this);
        for (const popup of [...this._popups])
            popup.destroy();
        this._service.unexport();
        this._service = null;
        this._expected = null;
        this._popups = null;
    }

    /** Works out where the popup opens, for the pointer's monitor, and remembers it for the window. */
    _place(pid, cardHeight) {
        const [x, y] = global.get_pointer();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
        const geometry = popupGeometry({x, y}, cardHeight, workArea);
        this._expected.set(pid, {
            position: {x: geometry.x, y: geometry.y},
            until: GLib.get_monotonic_time() + EXPECT_US,
        });
        return [VERSION, geometry.width, geometry.height, geometry.anchorY];
    }

    /**
     * Starts moving the popup with the pointer, for a press on the chat box's top edge or toolbar. Most
     * of the window is transparent space above the box, and a move the app starts can't take the
     * window's top above the top bar, so the box couldn't go higher than where it opened. This is
     * GNOME's Super+drag move instead, which doesn't keep the window's top on screen.
     */
    _move(pid) {
        const popup = [...this._popups].find(p => p.window.get_pid() === pid);
        if (!popup)
            return false;
        const op = Meta.GrabOp.MOVING_UNCONSTRAINED;
        const time = global.display.get_current_time_roundtrip();
        try {
            // GNOME 48+: the pointer's sprite.
            const backend = global.stage.get_context().get_backend();
            return popup.window.begin_grab_op(op, backend.get_pointer_sprite(global.stage), time, null);
        } catch {
            // GNOME 45 to 47: the pointer device and no touch sequence.
            const pointer = Clutter.get_default_backend().get_default_seat().get_pointer();
            return popup.window.begin_grab_op(op, pointer, null, time, null);
        }
    }

    /**
     * Gives the open popup the keyboard again: the hotkey, pressed while it's open over another window, brings
     * the new highlight into its chat. GNOME doesn't let an app focus its own window once it has lost focus.
     */
    _activate(pid) {
        const popup = [...this._popups].find(p => p.window.get_pid() === pid);
        if (!popup)
            return false;
        popup.window.make_above();
        Main.activateWindow(popup.window);
        return true;
    }

    _setHitRect(pid, rect) {
        const popup = [...this._popups].find(p => p.window.get_pid() === pid);
        if (!popup)
            return false;
        popup.setHitRect(rect);
        this._trackPointer();
        return true;
    }

    /** Follows the pointer while a popup lets clicks through, so it takes them again over its chat box. */
    _trackPointer() {
        const needed = this._popups && [...this._popups].some(p => p.hasHitRect);
        if (!needed) {
            this._stopTracking();
            return;
        }
        if (this._pointerTimer)
            return;
        const update = () => {
            for (const popup of this._popups ?? [])
                popup.updatePointer();
        };
        // The cursor tracker says when the pointer moves; a slow poll covers a missed move.
        const tracker = global.backend?.get_cursor_tracker?.();
        tracker?.connectObject('position-invalidated', update, this);
        this._tracker = tracker ?? null;
        this._pointerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
            update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTracking() {
        this._tracker?.disconnectObject(this);
        this._tracker = null;
        if (this._pointerTimer)
            GLib.source_remove(this._pointerTimer);
        this._pointerTimer = 0;
    }

    /** Remembers the focused window and the pointer, for screenshots after Kiki's popup opens over them. */
    _rememberSource() {
        this._forgetSource();
        const window = global.display.focus_window;
        if (window?.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        const [x, y] = global.get_pointer();
        this._source = {window, pointer: {x, y}};
        window.connectObject('unmanaging', () => this._forgetSource(), this);
        return true;
    }

    /**
     * The app the remembered window belongs to, as JSON: its desktop id ("google-chrome.desktop"), name, WM
     * class, flatpak id, title and process. "{}" when there's no remembered window.
     */
    _sourceApp() {
        const window = this._source?.window;
        if (!window)
            return '{}';
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return JSON.stringify({
            id: app?.get_id() ?? '',
            name: app?.get_name() ?? '',
            wmClass: window.get_wm_class() ?? '',
            sandboxedId: window.get_sandboxed_app_id() ?? '',
            title: window.get_title() ?? '',
            pid: window.get_pid(),
        });
    }

    _forgetSource() {
        this._source?.window.disconnectObject(this);
        this._source = null;
    }

    /** The windows on the desktop (normal ones), top of the stack first, as JSON. */
    _listWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        const focus = global.display.focus_window;
        const tracker = Shell.WindowTracker.get_default();
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && window.get_window_type() === Meta.WindowType.NORMAL);
        const sorted = global.display.sort_windows_by_stacking(windows).reverse().slice(0, MAX_WINDOWS);
        return JSON.stringify(sorted.map(window => {
            const app = tracker.get_window_app(window);
            const frame = window.get_frame_rect();
            return {
                id: String(window.get_id()),
                pid: window.get_pid(),
                app: app?.get_id() ?? '',
                name: app?.get_name() ?? '',
                wmClass: window.get_wm_class() ?? '',
                sandboxedId: window.get_sandboxed_app_id() ?? '',
                title: window.get_title() ?? '',
                focused: window === focus,
                minimized: window.minimized,
                onWorkspace: window.located_on_workspace(workspace),
                kiki: [...this._popups].some(popup => popup.window === window),
                source: this._source?.window === window && !this._source.selected,
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
            };
        }));
    }

    /** Makes the window with `id` (from ListWindows) the source, as RememberSource does for the focused one. */
    _selectSource(id) {
        const window = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(candidate => candidate && String(candidate.get_id()) === String(id));
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        this._forgetSource();
        const frame = window.get_frame_rect();
        this._source = {
            window,
            pointer: {x: frame.x + Math.round(frame.width / 2), y: frame.y + Math.round(frame.height / 2)},
            selected: true,
        };
        window.connectObject('unmanaging', () => this._forgetSource(), this);
        return true;
    }

    /** The installed apps that show in the app grid, as JSON [{id, name}]. */
    _listApps() {
        const apps = Shell.AppSystem.get_default().get_installed()
            .filter(info => info.should_show())
            .map(info => ({id: info.get_id(), name: info.get_name()}));
        return JSON.stringify(apps);
    }

    /** Starts the app with desktop id `id`, or brings it up when it's running. */
    _launchApp(id) {
        const app = Shell.AppSystem.get_default().lookup_app(String(id));
        if (!app)
            return false;
        app.activate();
        return true;
    }

    /** Answers a D-Bus call with (version, outcome), or with its error. */
    async _outcomeCall(invocation, run) {
        try {
            const outcome = await run();
            invocation.return_value(new GLib.Variant('(us)', [VERSION, outcome]));
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', `${e}`);
        }
    }

    /**
     * The source window, ready for the pointer: raised when something covers `spot` (a point in it). Returns
     * the window, or why not ("gone", "hidden", "busy", "covered").
     */
    async _pointerTarget(spot) {
        const window = this._source?.window;
        if (!window)
            return 'gone';
        const workspace = global.workspace_manager.get_active_workspace();
        if (window.minimized || !window.located_on_workspace(workspace))
            return 'hidden';
        if (Main.overview.visible || Main.modalCount > 0)
            return 'busy';
        if (this._reaches(window, spot))
            return window;
        // Something else is over that spot: bring the window to the front and wait for it.
        Main.activateWindow(window);
        for (let waited = 0; waited < RAISE_WAIT_MS; waited += 20) {
            await sleep(20);
            if (this._source?.window !== window)
                return 'gone';
            if (this._reaches(window, spot))
                return window;
        }
        return 'covered';
    }

    /** Where a fraction (0 to 1) of the window's width and height is on the stage. */
    _spotIn(window, x, y) {
        const frame = rectOf(window.get_frame_rect());
        const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
        return {
            x: frame.x + Math.round(clamp(x) * (frame.width - 1)),
            y: frame.y + Math.round(clamp(y) * (frame.height - 1)),
        };
    }

    /** Runs `act` with the hidden virtual pointer at `spot`, then puts the pointer back where it was. */
    async _withPointer(spot, act) {
        this._pointer ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const [startX, startY] = global.get_pointer();
        const tracker = global.backend?.get_cursor_tracker?.();
        const visible = tracker?.get_pointer_visible?.() ?? true;
        try {
            tracker?.set_pointer_visible?.(false);
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), spot.x, spot.y);
            this._updatePopups();
            await sleep(POINTER_SETTLE_MS);
            return await act(this._pointer);
        } finally {
            const [x, y] = global.get_pointer();
            // Back where it was. Not to the screen's corner, where the pointer is before anyone has moved it:
            // that's the Activities hot corner, and putting the pointer there opens the overview.
            const corner = startX === 0 && startY === 0;
            if (!corner && (Math.abs(x - startX) > 1 || Math.abs(y - startY) > 1))
                this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX, startY);
            tracker?.set_pointer_visible?.(visible);
            this._updatePopups();
        }
    }

    /**
     * Clicks in the source window at (`x`, `y`), fractions of its size, `count` times with `button`. The
     * window is raised first when something covers that spot, so the click reaches it.
     */
    async _clickAt(x, y, button, count) {
        const code = BUTTONS[String(button)] ?? Clutter.BUTTON_PRIMARY;
        const clicks = Math.min(3, Math.max(1, Number(count) || 1));
        const window = this._source?.window;
        if (!window)
            return 'gone';
        const spot = this._spotIn(window, x, y);
        const target = await this._pointerTarget(spot);
        if (typeof target === 'string')
            return target;
        this._cancelled = false;
        return this._withPointer(spot, async pointer => {
            for (let done = 0; done < clicks; done++) {
                if (this._cancelled)
                    return 'cancelled';
                if (done > 0)
                    await sleep(CLICK_GAP_MS);
                pointer.notify_button(GLib.get_monotonic_time(), code, Clutter.ButtonState.PRESSED);
                await sleep(CLICK_HOLD_MS);
                pointer.notify_button(GLib.get_monotonic_time(), code, Clutter.ButtonState.RELEASED);
            }
            return 'done';
        });
    }

    /** Drags with the left button through `points` ([x1, y1, x2, y2, ...], fractions of the source window). */
    async _dragPath(points) {
        const values = Array.from(points ?? []).map(Number);
        if (values.length < 4 || values.length % 2 !== 0 || values.length > 40)
            throw new Error('DragPath takes two or more points');
        const window = this._source?.window;
        if (!window)
            return 'gone';
        const spots = [];
        for (let i = 0; i < values.length; i += 2)
            spots.push(this._spotIn(window, values[i], values[i + 1]));
        const target = await this._pointerTarget(spots[0]);
        if (typeof target === 'string')
            return target;
        this._cancelled = false;
        return this._withPointer(spots[0], async pointer => {
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(CLICK_HOLD_MS);
            try {
                for (let i = 1; i < spots.length; i++) {
                    const from = spots[i - 1];
                    const to = spots[i];
                    for (let step = 1; step <= DRAG_STEPS; step++) {
                        if (this._cancelled)
                            return 'cancelled';
                        const t = step / DRAG_STEPS;
                        pointer.notify_absolute_motion(
                            GLib.get_monotonic_time(),
                            Math.round(from.x + (to.x - from.x) * t),
                            Math.round(from.y + (to.y - from.y) * t));
                        await sleep(DRAG_STEP_MS);
                    }
                }
                await sleep(CLICK_HOLD_MS);
            } finally {
                pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            }
            return 'done';
        });
    }

    /** Focuses the source window and presses one key chord there ("enter", "ctrl+a", "pageup"). */
    async _keyChord(chord) {
        const keys = parseChord(chord);
        if (!keys)
            throw new Error(`Kiki doesn't press "${chord}"`);
        if (!await this._focusSource())
            return false;
        await this._press(keys);
        return true;
    }

    async _pasteToSource([terminal], invocation) {
        await this._reply(invocation, () => this._paste(terminal));
    }

    /** Answers a D-Bus call with (version, what `run` returned), or with its error. */
    async _reply(invocation, run) {
        try {
            const result = await run();
            invocation.return_value(new GLib.Variant('(ub)', [VERSION, result]));
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', `${e}`);
        }
    }

    /**
     * Focuses the remembered window and types Ctrl+V (Ctrl+Shift+V in terminals), so what Kiki put on the
     * clipboard goes in at its cursor. False when that window is gone or won't take focus.
     */
    async _paste(terminal) {
        if (!await this._focusSource())
            return false;
        await this._press(KEY_STEPS[terminal ? 'ctrl+shift+v' : 'ctrl+v']);
        return true;
    }

    /** Presses the named shortcuts in the remembered window, one after another. False if it won't take focus. */
    async _keysToSource(steps) {
        const parsed = steps.map(parseStep);
        const unknown = parsed.indexOf(null);
        if (unknown >= 0)
            throw new Error(`Kiki doesn't press "${steps[unknown]}"`);
        if (!await this._focusSource())
            return false;
        for (const [index, {keys, count}] of parsed.entries()) {
            if (index > 0)
                await sleep(STEP_GAP_MS);
            // Focus can move (another window, the overview) while the app works: stop rather than type elsewhere.
            if (!this._sourceReady(this._source?.window))
                return false;
            if (count === 1) {
                await this._press(keys);
                continue;
            }
            for (let done = 0; done < count; done++) {
                if (this._cancelled)
                    return false;
                if (done > 0 && done % REPEAT_CHECK_EVERY === 0 && !this._sourceReady(this._source?.window))
                    return false;
                await this._press(keys, REPEAT_GAP_MS);
            }
        }
        return true;
    }

    /** The keys go to the window only once it's focused and nothing of the shell's holds the keyboard. */
    _sourceReady(window) {
        return Boolean(window) && global.display.focus_window === window && !Main.overview.visible && Main.modalCount === 0;
    }

    /** Focuses the remembered window and waits until it takes the keyboard. False when it's gone or won't. */
    async _focusSource() {
        const window = this._source?.window;
        if (!window)
            return false;
        if (this._sourceReady(window))
            return true;
        // The overview keeps the keyboard even while the window stays focused, and as it closes it focuses
        // the window it was showing: close it first, so it can't take the focus back.
        if (Main.overview.visible) {
            Main.overview.hide();
            for (let waited = 0; Main.overview.visible && waited < FOCUS_WAIT_MS; waited += 20)
                await sleep(20);
        }
        Main.activateWindow(window);
        for (let waited = 0; !this._sourceReady(window); waited += 20) {
            if (waited >= FOCUS_WAIT_MS || this._source?.window !== window)
                return false;
            // Something else took the focus (a closing menu, a window that just mapped): ask again, once.
            if (waited === FOCUS_WAIT_MS / 2 && global.display.focus_window !== window)
                Main.activateWindow(window);
            await sleep(20);
        }
        await sleep(KEY_SETTLE_MS);
        return this._sourceReady(window);
    }

    /** Presses `keys` together, in order, and lets them go in reverse, `gap` ms apart. */
    async _press(keys, gap = KEY_GAP_MS) {
        this._keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        for (const [state, order] of [[Clutter.KeyState.PRESSED, keys], [Clutter.KeyState.RELEASED, [...keys].reverse()]]) {
            for (const key of order) {
                this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, state);
                await sleep(gap);
            }
        }
    }

    /** Puts `text` on the clipboard, whichever window has the keyboard. */
    _setClipboard(text) {
        if (text.length > MAX_CLIPBOARD)
            return false;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        return true;
    }

    async _scrollSourceCall([percent, pixels], invocation) {
        try {
            const outcome = await this._scrollSource(percent, pixels);
            invocation.return_value(new GLib.Variant('(us)', [VERSION, outcome]));
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', `${e}`);
        }
    }

    /**
     * Scrolls the remembered window by `percent` of its height plus `pixels` (down when positive), with a
     * virtual touchpad. Scrolls go to the window under the pointer, so the pointer moves onto the window for
     * a moment, hidden, and goes back. The focus stays where it is, so Kiki's popup keeps the keyboard.
     *
     * Returns "scrolled", or why not: "gone" (the window closed), "hidden" (minimized or on another
     * workspace), "busy" (the overview or a dialog of the shell's is open), "covered" (other windows are over
     * all of it).
     */
    async _scrollSource(percent, pixels) {
        const window = this._source?.window;
        if (!window)
            return 'gone';
        const workspace = global.workspace_manager.get_active_workspace();
        if (window.minimized || !window.located_on_workspace(workspace))
            return 'hidden';
        if (Main.overview.visible || Main.modalCount > 0)
            return 'busy';
        const frame = rectOf(window.get_frame_rect());
        const point = scrollPoint(frame, spot => this._reaches(window, spot));
        if (!point)
            return 'covered';
        const total = Math.max(-MAX_SCROLL_PX, Math.min(Math.round(frame.height * percent / 100) + pixels, MAX_SCROLL_PX));
        if (total === 0)
            return 'scrolled';

        this._pointer ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const [startX, startY] = global.get_pointer();
        const tracker = global.backend?.get_cursor_tracker?.();
        const visible = tracker?.get_pointer_visible?.() ?? true;
        try {
            tracker?.set_pointer_visible?.(false);
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), point.x, point.y);
            this._updatePopups();
            await sleep(POINTER_SETTLE_MS);
            for (let left = total; left !== 0;) {
                if (this._cancelled)
                    break;
                const piece = Math.sign(left) * Math.min(Math.abs(left), SCROLL_PIECE_PX);
                this._pointer.notify_scroll_continuous(
                    GLib.get_monotonic_time(), 0, piece / PIXELS_PER_SCROLL,
                    Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
                left -= piece;
                await sleep(SCROLL_GAP_MS);
            }
            await sleep(SCROLL_STOP_MS);
            this._pointer.notify_scroll_continuous(
                GLib.get_monotonic_time(), 0, 0, Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.VERTICAL);
        } finally {
            // Back where it was, unless the person moved it meanwhile.
            const [x, y] = global.get_pointer();
            if (Math.abs(x - point.x) <= 1 && Math.abs(y - point.y) <= 1)
                this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX, startY);
            tracker?.set_pointer_visible?.(visible);
            this._updatePopups();
        }
        return 'scrolled';
    }

    /**
     * Whether a scroll at `point` would reach `window`: it's the top window there, or only Kiki's popups are
     * above it there, away from their chat box (where they let the pointer through).
     */
    _reaches(window, point) {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(other => other && other.showing_on_its_workspace() && other.located_on_workspace(workspace));
        for (const other of global.display.sort_windows_by_stacking(windows).reverse()) {
            if (!inside(point, rectOf(other.get_frame_rect())))
                continue;
            if (other === window)
                return true;
            const popup = [...this._popups].find(p => p.window === other);
            if (!popup || popup.takes(point))
                return false;
        }
        return false;
    }

    /** Has each popup take the pointer, or let it through, for where the pointer is now. */
    _updatePopups() {
        for (const popup of this._popups ?? [])
            popup.updatePointer();
    }

    async _captureSource([maxWidth, maxHeight], invocation) {
        try {
            const path = await this._capture(maxWidth, maxHeight);
            invocation.return_value(new GLib.Variant('(us)', [VERSION, path]));
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', `${e}`);
        }
    }

    /** Saves a PNG of the remembered window around the pointer, for Kiki's context, and returns its path. */
    async _capture(maxWidth, maxHeight) {
        const actor = this._source?.window.get_compositor_private();
        if (!actor)
            throw new Error('no window to capture');
        const size = value => Math.max(1, Math.min(value, MAX_CROP));
        const crop = cropAround(
            this._source.pointer, rectOf(this._source.window.get_frame_rect()), size(maxWidth), size(maxHeight));
        // The window's own pixels, so windows on top (Kiki's popup) don't show. Mutter 50 places a
        // clipped paint wrongly for windows away from the screen's corner, so paint it all and crop below.
        const texture = actor.paint_to_content(null)?.get_texture();
        if (!texture)
            throw new Error("couldn't draw the window");
        // The texture covers the actor (the window plus its shadow) at the actor's scale.
        const scale = actor.get_resource_scale();
        const [actorX, actorY] = actor.get_position();
        const x = Math.max(0, Math.round((crop.x - actorX) * scale));
        const y = Math.max(0, Math.round((crop.y - actorY) * scale));
        const width = Math.min(Math.round(crop.width * scale), texture.get_width() - x);
        const height = Math.min(Math.round(crop.height * scale), texture.get_height() - y);
        if (width <= 0 || height <= 0)
            throw new Error('the crop is outside the window');

        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'kiki']);
        GLib.mkdir_with_parents(dir, 0o700);
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'source.png']));
        const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
        try {
            await Shell.Screenshot.composite_to_stream(texture, x, y, width, height, scale, null, 0, 0, 1, stream);
        } finally {
            stream.close(null);
        }
        return file.get_path();
    }

    _windowCreated(window) {
        // Menus and tooltips are windows too; only the popup itself is a normal one.
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const pid = window.get_pid();
        const expected = this._expected.get(pid);
        if (!expected)
            return;
        this._expected.delete(pid);
        if (GLib.get_monotonic_time() > expected.until)
            return;
        this._popups.add(new Popup(window, expected.position, popup => {
            this._popups?.delete(popup);
            this._trackPointer();
        }));
    }
}

function rectOf(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

/** Makes a window's actor and its surfaces (which pick themselves) take the pointer, or not. */
function setReactive(actor, reactive) {
    actor.reactive = reactive;
    for (const child of actor.get_children())
        setReactive(child, reactive);
}
