// The "Kiki is using your computer" banner: a strip at the top of the screen while Kiki clicks, types, scrolls
// or pastes in the person's windows, with a Stop button. While it shows, Esc stops too. Stopping tells Kiki
// over its socket ($XDG_RUNTIME_DIR/kiki.sock, the hotkey's) and cancels what the extension itself is doing.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Below the top bar. */
const TOP_GAP = 8;
/** Longest banner text. */
const MAX_TEXT = 120;

export class Banner {
    /** `onStop` runs when the person presses Stop or Esc. */
    constructor(onStop) {
        this._onStop = onStop;
        this._actor = null;
        this._accelerator = 0;
        this._acceleratorSignal = 0;
    }

    get showing() {
        return this._actor !== null;
    }

    show(text) {
        const label = String(text).slice(0, MAX_TEXT) || 'Kiki is using your computer';
        if (this._actor) {
            this._label.text = label;
            return true;
        }
        const box = new St.BoxLayout({
            style_class: 'kiki-banner',
            style: 'background-color: rgba(18, 18, 20, 0.94); color: #f4f4f5; border-radius: 20px; '
                + 'padding: 7px 10px 7px 16px; spacing: 12px; font-size: 13px; font-weight: 600; '
                + 'border: 1px solid rgba(255, 255, 255, 0.12);',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const dot = new St.Widget({
            style: 'background-color: #7c5cff; border-radius: 6px; width: 10px; height: 10px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER});
        const hint = new St.Label({
            text: 'Esc to cancel',
            style: 'color: rgba(244, 244, 245, 0.6); font-weight: 400;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const stop = new St.Button({
            label: 'Stop',
            style: 'background-color: rgba(255, 255, 255, 0.14); color: #f4f4f5; border-radius: 14px; '
                + 'padding: 4px 12px; font-weight: 600;',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        stop.connect('clicked', () => this.stop());
        box.add_child(dot);
        box.add_child(this._label);
        box.add_child(hint);
        box.add_child(stop);
        this._actor = box;
        Main.layoutManager.addTopChrome(box, {trackFullscreen: false});
        this._place();
        this._grabEscape();
        return true;
    }

    /** Centers the banner at the top of the primary monitor, under the top bar. */
    _place() {
        if (!this._actor)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, width] = this._actor.get_preferred_width(-1);
        const panelHeight = Main.panel?.height ?? 0;
        this._actor.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + panelHeight + TOP_GAP));
    }

    /**
     * Grabs Esc for as long as the banner shows: Kiki is working in someone else's window, so the person
     * can't press Stop in the popup without clicking it first.
     */
    _grabEscape() {
        try {
            this._accelerator = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
            if (this._accelerator === Meta.KeyBindingAction.NONE) {
                this._accelerator = 0;
                return;
            }
            const name = Meta.external_binding_name_for_action(this._accelerator);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
            this._acceleratorSignal = global.display.connect('accelerator-activated', (_display, action) => {
                if (action === this._accelerator)
                    this.stop();
            });
        } catch (e) {
            console.warn(`Kiki: couldn't grab Esc for the banner: ${e}`);
            this._accelerator = 0;
        }
    }

    _releaseEscape() {
        if (this._acceleratorSignal) {
            global.display.disconnect(this._acceleratorSignal);
            this._acceleratorSignal = 0;
        }
        if (this._accelerator) {
            try {
                global.display.ungrab_accelerator(this._accelerator);
            } catch {
                // Already gone.
            }
            this._accelerator = 0;
        }
    }

    /** The person pressed Stop or Esc: Kiki hears about it and the banner goes. */
    stop() {
        this._onStop?.();
        this.hide();
        tellKiki('stop');
    }

    hide() {
        this._releaseEscape();
        if (!this._actor)
            return false;
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
        this._label = null;
        return true;
    }

    destroy() {
        this.hide();
        this._onStop = null;
    }
}

/** Writes one line to Kiki's socket, the one its GNOME shortcut says "ask" on. */
export function tellKiki(message) {
    try {
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'kiki.sock']);
        const client = new Gio.SocketClient();
        const connection = client.connect(Gio.UnixSocketAddress.new(path), null);
        connection.get_output_stream().write_all(`${message}\n`, null);
        connection.close(null);
        return true;
    } catch (e) {
        console.warn(`Kiki: couldn't reach Kiki's socket: ${e}`);
        return false;
    }
}
