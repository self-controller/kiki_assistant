// Kiki's GNOME Shell helper. Apps can't place their own windows on Wayland, so this opens Kiki's
// popup with its chat box at the pointer, and focuses it. Right before it shows a popup, Kiki calls
// PlacePopup over D-Bus to learn the window's size and where the chat box sits in it.
// When the hotkey is pressed, Kiki calls RememberSource; CaptureSource then takes a screenshot of that
// window around the pointer, from the window's own pixels, so Kiki's popup on top of it doesn't show.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cropAround} from './crop.js';
import {popupGeometry} from './placement.js';

Gio._promisify(Shell.Screenshot, 'composite_to_stream');

const VERSION = 3;
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
    <method name="RememberSource">
      <arg type="u" direction="out" name="version"/>
      <arg type="b" direction="out" name="found"/>
    </method>
    <method name="CaptureSource">
      <arg type="i" direction="in" name="maxWidth"/>
      <arg type="i" direction="in" name="maxHeight"/>
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="path"/>
    </method>
    <method name="Version">
      <arg type="u" direction="out" name="version"/>
    </method>
  </interface>
</node>`;

/** Largest crop CaptureSource takes, in logical pixels. */
const MAX_CROP = 4096;

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
            RememberSource: () => [VERSION, this._rememberSource()],
            CaptureSourceAsync: (params, invocation) => this._captureSource(params, invocation),
            Version: () => VERSION,
        });
        this._service.export(Gio.DBus.session, OBJECT_PATH);
        global.display.connectObject('window-created', (_display, window) => this._windowCreated(window), this);
    }

    disable() {
        this._forgetSource();
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

    _forgetSource() {
        this._source?.window.disconnectObject(this);
        this._source = null;
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
        this._popups.add(new Popup(window, expected.position, popup => this._popups?.delete(popup)));
    }
}

function rectOf(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}
