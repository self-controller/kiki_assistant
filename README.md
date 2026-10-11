<p align="center">
  <img src="docs/mascot.svg" width="96" alt="Kiki, a violet triangle with two eyes">
</p>

<h1 align="center">Kiki</h1>

<p align="center">
  Highlight text in any app, press <b>Ctrl+Alt+K</b>, and ask about it.
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Highlighting text, pressing Ctrl+Alt+K, and Kiki answering in a popup next to the pointer">
</p>

Kiki is a desktop assistant for Linux (GNOME) and macOS. Press the hotkey and a small black chat box opens
at the pointer, with Kiki (a little violet triangle) sitting on top. Kiki looks at the window around it
(app, window title, nearby text, and a screenshot when there is no text to read), searches the web and reads
pages when it needs to, and answers. While it works, the box grows to show what it's thinking, searching for
and reading.

## Features

- **Works in any app.** Reads the selection, window title and nearby text through accessibility, and takes
  a screenshot when there is no text to read. In terminals and editors, it reads only the lines around the
  highlight (or the cursor). In apps that don't share their text, such as VS Code, it takes a screenshot of
  the part of the window around the pointer.
- **Web search and page reading.** Answers come from Claude with web search and fetch.
- **Pick the model and how hard it thinks.** The composer has a model picker (Haiku, Sonnet, Opus), an
  effort button that cycles Low, Medium, High and XHigh, and a **Search** toggle. Kiki remembers your picks.
- **Screenshot button.** The camera next to **Search** shows Kiki a screenshot of the window you were in,
  around the pointer. It starts on when Kiki already took one (in auto mode, when the window had no text to
  read). Turn it on to add a screenshot, or off to leave it out. Kiki's own popup never shows in it. Turned
  on after the first question, it sends the screenshot with your next one. On GNOME it needs the GNOME
  helper.
- **Images.** Paste, drop or add (**+**) images.
- **You see what's shared.** The popup shows every piece of context as a chip before you send. Click ✕ to
  leave any of it out.
- **Invite codes instead of API keys.** You host the server with your Anthropic API key. Friends get an
  invite code with a daily question limit.

## How it works

Kiki has two parts:

- **`server/`**: holds your Anthropic API key, checks invite codes, enforces daily limits, and streams
  answers from Claude with the web search tool.
- **`desktop/`**: an Electron app. It captures the selection and context, shows the popup, and talks to the
  server. Users only ever see an invite code, never your API key.

```
hotkey ─► capture selection + context ─► popup ─► POST /v1/conversations (SSE) ─► server ─► Claude + web search
```

`shared/` holds the wire protocol types used by both.

## Quick start

Requires Node 22.18 or newer and an [Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/YOUR-USERNAME/kiki.git && cd kiki
npm install
cp server/.env.example server/.env      # then add ANTHROPIC_API_KEY
npm run dev:server                      # http://127.0.0.1:8787
```

In a second terminal, create an invite code for yourself and start the app:

```sh
npm run codes -- create me --limit 100
npm run dev:desktop
```

The first launch opens Settings. Enter `http://127.0.0.1:8787` and the invite code, then click **Save and test
connection**. On Linux, also follow the [GNOME setup](#linux-gnome-wayland) steps.

## Server

The server runs TypeScript directly, with no build step.

### Invite codes

Create an invite code for each person. Each code is shown once:

```sh
npm run codes -- create alice --limit 100   # questions per day
npm run codes -- list
npm run codes -- usage --days 7             # requests, tokens, web searches per code
npm run codes -- revoke alice
```

### Running the server in the background

For a server on your own Linux machine, run it as a systemd user service. It then starts when you log in and
restarts if it crashes:

```sh
npm run service -w server -- install      # writes ~/.config/systemd/user/kiki-server.service and starts it
journalctl --user -u kiki-server -f       # logs
npm run service -w server -- uninstall
```

The service uses `server/.env` like `npm run dev:server`, but it doesn't reload when you edit the code. Run
`systemctl --user restart kiki-server` after changes.

### Deploying

Users connect over the internet, so run the server behind HTTPS. The desktop app refuses plain `http://` for
anything other than localhost.

```sh
docker build -f server/Dockerfile -t kiki-server .
docker run -d --name kiki -p 8787:8787 -v kiki-data:/data --env-file server/.env kiki-server
docker exec kiki node --disable-warning=ExperimentalWarning src/cli.ts create alice
```

Put a TLS-terminating proxy (Caddy, nginx, or your host's load balancer) in front of port 8787. Invite codes
and usage live in SQLite at `/data/kiki.db`. Conversations are kept in memory for an hour; after a restart,
the app transparently starts a new conversation with the same context.

### Configuration (`server/.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `KIKI_MODEL` | `claude-opus-5-5` | Model for apps that don't pick one (the picker maps Haiku, Sonnet and Opus to `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`) |
| `KIKI_EFFORT` | `low` | Effort for apps that don't pick one |
| `KIKI_THINK_EFFORT` | `high` | Effort for older apps' **Think** toggle |
| `KIKI_MAX_SEARCHES` | `3` | Web searches allowed per answer |
| `KIKI_MAX_FETCHES` | `2` | Pages Claude may fetch and read per answer; `0` turns it off |
| `KIKI_STT_URL` / `KIKI_STT_KEY` / `KIKI_STT_MODEL` | (off) | `/v1/transcribe`: any OpenAI-compatible `/audio/transcriptions` endpoint (the desktop app no longer records voice) |
| `KIKI_FALLBACKS` | `default` | Server-side refusal fallback (`fallbacks: "default"`); `off` disables it |
| `KIKI_DB_PATH` | `kiki.db` | SQLite file for codes and usage |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Use `0.0.0.0` behind a proxy (the Docker image does) |

**Costs.** Each first question sends the selection plus nearby text, or a screenshot:

- **Terminals and editors:** about 100 lines, at most 8k characters (about 2k tokens).
- **Pages and other windows:** up to about 24k characters (about 6k tokens).
- **A screenshot of the window around the pointer:** at most 1400×700, about 1–1.5k tokens.

Follow-ups reuse that context from the prompt cache. A fetched page adds up to about
8k tokens. Per-code daily limits cap usage. Also set a monthly spend limit in the Anthropic Console as a
backstop.

## Desktop app

```sh
npm run dev:desktop
```

The first launch opens Settings. Enter the server address and an invite code, then click **Save and test
connection**.

### Linux (GNOME, Wayland)

In Settings:

1. **Install GNOME shortcut** adds a custom keyboard shortcut that runs `kiki --ask`. On Wayland, apps can't
   listen for global keys themselves.
2. **Install GNOME helper** adds a small GNOME Shell extension (`desktop/resources/gnome-extension`) that opens
   the popup with its chat box at the pointer, and focuses it. On Wayland, apps can't place their own
   windows. It also takes the screenshot of the window around the pointer. GNOME loads the extension (and
   any update to it) the next time you log in; until then, the popup opens in the middle of the screen.
   When a newer Kiki bundles a newer helper, Settings shows **Update GNOME helper**.
3. **Read text in browsers** turns on GNOME accessibility support (`toolkit-accessibility`), so Firefox,
   Zen, Chrome and Electron apps expose their page text. Restart the browser afterwards. GTK apps (Text
   Editor, terminals, Files) work without it.

Linux requirements: `wl-clipboard` (or `xclip` on X11), `python3-gobject`, `at-spi2-core`. GNOME desktops
usually have all of these. The rpm and deb packages declare them as dependencies.

**Using Kiki from a source checkout.** The GNOME shortcut and the **Start Kiki when I log in** item both run
this checkout's last build, without the dev server, so run `npm run build -w desktop` after changing the app,
then quit Kiki. If you also run your own server, see [Running the server in the background](#running-the-server-in-the-background) so
the hotkey works without starting anything by hand.

### macOS

Kiki lives in the menu bar, and the hotkey is **Control+Option+K**. Click **Grant permissions** in Settings,
then allow Kiki under *Privacy & Security* in both **Accessibility** (to read the selection) and **Screen
Recording** (to see the page around it).

### Building packages

Set your server's address before building, so users only need to paste their code:

```sh
echo 'MAIN_VITE_KIKI_SERVER_URL=https://kiki.example.com' > desktop/.env
npm run dist:linux -w desktop    # AppImage, rpm, deb in desktop/release/
npm run dist:mac -w desktop      # dmg; run this on a Mac
```

The mac build is unsigned. Users have to right-click and choose Open the first time, unless you sign and
notarize it with an Apple Developer ID (see electron-builder's code-signing docs).

## Privacy: what gets sent

When you ask a question, Kiki sends the highlighted text, and the popup has already shown the rest of what
will be shared:

- the app name and window title
- the nearby text (character count)
- the screenshot (thumbnail)
- any images you pasted or attached (thumbnails)

Click ✕ on any chip to leave it out.

The screenshot setting is **auto** on Linux, meaning only when the window's text can't be read. It is
**always** on macOS. You can set it to **never**, which also hides the camera button. Otherwise the camera
button turns the screenshot on or off for each popup. With the GNOME helper (version 3 or newer), the
screenshot covers only the window you were in, around the pointer, not the whole screen. Screen content is sent to your Kiki server and then to
Claude. The prompt tells Claude to treat it as material to read, not as instructions.

## Development

```sh
npm test                       # server + desktop unit tests
npm run typecheck
npm run mock -w server         # Kiki API with a fake Claude: no API key, echoes the context it received
npm run smoke -w server        # live check against the real API (uses ANTHROPIC_API_KEY, costs a few cents)
```

The mock server prints an access code. Every answer "thinks" first, questions containing "latest" or "search"
(or asked with the Search toggle) get a fake web search and page read.

To test what the Linux capture sees, highlight something and run:

```sh
/usr/bin/python3 desktop/resources/kiki_context.py --delay 3   # switch to the window within 3 seconds
```

### macOS test checklist

The macOS capture code (`desktop/src/main/capture/mac.ts`) has not been run on a Mac yet. Check that:

- [ ] Kiki starts with only a menu bar icon and no Dock icon. The tray menu opens Settings.
- [ ] **Grant permissions** shows the Accessibility prompt, then opens Screen Recording settings.
- [ ] With text selected in TextEdit or Notes, Control+Option+K opens the popup next to the cursor, showing
      the app and window chips and a screenshot chip.
- [ ] The popup opens over a full-screen app, grows upward as the answer streams in, and clicking outside it
      or switching apps closes it.
- [ ] In Safari and Chrome, where selection reading falls back to Cmd+C, the selection appears. Afterwards,
      the previous clipboard contents (text and an image) are restored.
- [ ] Copy and paste work in the popup and Settings text fields.
- [ ] **Start Kiki when I log in** adds a login item.

## Known limitations

- **Popup placement on GNOME Wayland needs the helper:** apps can't place their own windows there, so Kiki's
  GNOME Shell extension does it. Without it, the popup opens in the middle of the screen.
  (A transparent full-screen overlay doesn't work: GNOME paints black behind full-screen windows.) Drag the
  popup by Kiki or by the toolbar's empty space to move it.
- **The popup's see-through space takes clicks.** Its window is sized once for the tallest chat box, so the
  box can grow and glide without the window resizing. A click in the clear space above a short box closes
  the popup rather than reaching the app underneath. Electron can't limit a window's input region on Wayland.
- **Stale selections on Linux:** when an app doesn't expose its selection through accessibility, Kiki uses
  the Linux primary selection, which is "the last text highlighted anywhere". The popup doesn't show the
  highlighted text, so an answer about different text is the sign that this happened.
- **Screenshot permission on GNOME:** without the GNOME helper, the screenshot comes from the desktop portal.
  The first time, GNOME may ask for permission.
- **Terminals:** Ptyxis and other GTK 4 terminals share only what is on screen. A terminal's text shows up
  once its screen changes after accessibility is on. A window that has printed nothing since then reads as
  empty, so Kiki takes a screenshot instead. When nothing is highlighted in the terminal itself, Kiki ignores
  text highlighted in other windows.
- **Hotkey delay:** pressing the hotkey starts a short-lived second `kiki` process to signal the running app.
  That adds about 0.4 s before capture starts.
