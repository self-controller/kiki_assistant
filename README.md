<p align="center">
  <img src="docs/mascot.svg" width="96" alt="Kiki, a violet triangle with two eyes">
</p>

<h1 align="center">Kiki</h1>

<p align="center">
  Highlight text in any app, press <b>Ctrl+Alt+K</b>, and ask about it.
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Asking Kiki to write a Substack note, then inserting its draft into the editor from an edit card">
</p>

Kiki is a desktop assistant for Linux (GNOME) and macOS. Press the hotkey and a small black chat box opens
at the pointer, with Kiki (a little violet triangle) sitting on top. Kiki looks at the window around it
(app, window title, nearby text, and a screenshot when you press the camera button), searches the web and reads
pages when it needs to, and answers. While it works, the box grows to show what it's thinking, searching for
and reading.

## Features

- **Works in any app.** Reads the selection, window title and nearby text. On a long page with nothing
  highlighted, it keeps the text around what's on screen. In terminals and editors, it reads only the lines
  around the highlight (or the cursor). For apps that don't share their text, such as VS Code, press the
  camera button.
- **Web search and page reading.** Kiki searches the web and reads pages when a question needs it.
- **Searches in your browser.** Ask Kiki to search somewhere ("search Google Images for cute puppies", "find
  this on YouTube", "search Substack for this") and it opens the search in a new browser tab right away. It
  can open Google, Google Images, YouTube, Google Maps and Google News searches, or a Google search of one
  site. Kiki builds the link itself, so it can only ever open a search, never another page.
- **Scrolling.** Ask about what's further along ("scroll LinkedIn and find a post you'd find funny", "what's
  below?", "go through this thread") and Kiki scrolls the window you were in, one screen at a time, reading
  each screen as it goes. Then it scrolls back to what it picked, so it's on screen as it answers. It can
  also press buttons and links there after you approve them. See [Scrolling and pressing](#scrolling-and-pressing).
- **Pick the model and how hard it thinks.** The composer has a model picker (Haiku, Sonnet, Opus), an
  effort button that cycles Low, Medium, High and XHigh, and a **Search** toggle. Kiki remembers your picks.
- **Screenshot button.** The camera next to **Search** shows Kiki a screenshot of the window you were in,
  around the pointer. It starts off; press it to take the screenshot, and again to leave it out. Kiki's own
  popup never shows in it. Turned on after the first question, it sends the screenshot with your next one.
- **Images.** Paste, drop or add (**+**) images.
- **Calendar events and emails.** Ask Kiki to add something to your calendar, or to write or reply to an
  email. It shows a card you can edit first. **Open in Google Calendar** or **Open in Gmail** then opens the
  event or email, filled in, in your browser.
- **Edits at your cursor.** Ask Kiki to fix, rewrite, translate or write text ("fix the grammar", "rename
  this variable", "write a command for this"), and it shows a card with the new text. Edit it if you like,
  then press **Replace** (or **Insert** when nothing is highlighted, or **Paste** in a terminal). Nothing
  changes in your app until you do, and **Copy** always works instead. See [Edits](#edits).
- **Changes in several places, and forms.** "Fix the typos in this email" or "rename foo everywhere" shows
  one card listing every change. Each change has a tick box, and you can click it to edit it. Then
  **Apply** them all at once. "Fill this form with my details" works the same way for the form fields on the
  page. It works in Google Docs too. See [Changes and forms](#changes-and-forms).
- **Past sessions.** Click Kiki (the triangle on top of the popup) to see your earlier sessions, then pick one
  to read it and keep asking. They're saved only on your computer: the questions, the answers, and the
  context each session started with (screenshots and images aren't saved).
- **You see what's shared.** The popup shows every piece of context as a chip before you send. Click ✕ to
  leave any of it out.
- **No API key needed.** Sign in with the invite code you were given.

## Getting started

1. Download Kiki for your computer from the [Releases page](https://github.com/self-controller/kiki_assistant/releases):
   the AppImage, rpm or deb on Linux, or the dmg on macOS.
2. Start Kiki. The first launch opens Settings, with the server address already filled in.
3. Paste your invite code and click **Save and test connection**.
4. Follow the setup steps for [Linux](#linux-gnome-wayland) or [macOS](#macos) below.

Your invite code comes with a daily question limit, which resets at midnight UTC.

**Personality** in Settings changes how Kiki talks in new conversations: its usual voice, like Camus,
Dostoevsky and Nietzsche, or your own prompt (up to 2,000 characters).

### Linux (GNOME, Wayland)

In Settings:

1. **Install GNOME shortcut** adds the **Ctrl+Alt+K** keyboard shortcut.
2. **Install GNOME helper** adds a small GNOME Shell extension. It opens the popup at the pointer, takes the
   screenshot of the window you were in, and puts Kiki's edits, changes and form fills into your apps. It
   also lets Kiki scroll any app. GNOME loads the helper the next time you log in; until then, the popup
   opens in the middle of the screen. When an update to Kiki brings a newer helper, Settings shows
   **Update GNOME helper**. Click it, then log out and back in.
3. **Read text in browsers** lets Kiki read the page text in Firefox, Zen, Chrome and Electron apps. Restart
   the browser afterwards. GTK apps (Text Editor, terminals, Files) work without it.

The rpm and deb packages install everything else Kiki needs. With the AppImage, make sure you have
`wl-clipboard` (or `xclip` on X11), `python3-gobject` and `at-spi2-core`. GNOME desktops usually have all of
these.

**Start Kiki when I log in** in Settings starts Kiki in the background, so the first hotkey press doesn't
wait for it to start.

### macOS

Kiki lives in the menu bar, and the hotkey is **Control+Option+K**. Click **Grant permissions** in Settings,
then allow Kiki under *Privacy & Security* in both **Accessibility** (to read the selection) and **Screen
Recording** (to see the page around it).

The first time you open Kiki, right-click it and choose **Open**, because the app isn't signed yet.

## Using Kiki

### Edits

When the window you pressed the hotkey in has a text cursor, Kiki can suggest an edit. You get a card with
the new text, which you can change before you use it.

- **Replace** (or **Insert**) puts the text into your app. In GTK apps and browsers on Linux, Kiki writes
  over exactly the text you highlighted, after checking it's still there. If you changed it in the meantime,
  the card says so, and nothing is written. Elsewhere (VS Code, terminals, GTK 4 apps, Google Docs, and on
  macOS), it brings your window back and pastes at the cursor.
- **Copy** puts the text on your clipboard for you to paste yourself.

In a terminal, the text goes in at the prompt and doesn't run until you press Enter. After an edit, a
follow-up such as "shorter" edits Kiki's new text.

### Changes and forms

**Changes in several places.** When your cursor is in a text field, a message you're writing or an editor,
Kiki can change it in several places at once. It reads the whole field (up to 16,000 characters), or in
editors the lines around your cursor.
- Each change replaces one exact piece of the text. Kiki checks every change against your text before the
  card shows.
- **Apply** makes the ticked changes. In rich text, a change goes in without touching the formatting around
  it.
- **Copy all** puts the whole text, with the changes made, on your clipboard. Kiki puts your clipboard back
  after pasting several changes.

**Google Docs.** Docs doesn't share its text, so turn on the camera so Kiki can see the page. Kiki then makes
each change with Docs' own Find and replace. Changes Docs finds more than once are skipped and listed on the
card.

**Forms.** When the page or window has at least two labelled text fields on screen, "fill this in" shows a
card with a value for each field. The card shows the label, the new value (which you can edit) and the old
one. Kiki never sees password fields.

### Scrolling and pressing

Kiki can scroll the window you asked from and read what's on screen as it goes. Each step shows up in what
it's thinking, and one answer scrolls at most 15 times.

- **What it reads.** The text on screen. With the camera on, it also sees a screenshot of each screen. Apps
  that don't share their text (VS Code, Google Docs) can only be seen with the camera on. Removing the
  nearby-text chip keeps the window's text out of scrolling too.
- **Pressing.** "Like it" or "open the second post" shows a card listing each button or link, with the text
  just before it. Nothing is pressed until you press **Press**. Kiki checks first that each one is still
  where it was, so a feed that shifted can't make it press the wrong post's button.
- **Forms further down.** Fields that scroll into view join the form, so "fill this in" works after scrolling
  to them.

## Privacy: what gets sent

When you ask a question, Kiki sends the highlighted text, and the popup has already shown the rest of what
will be shared:

- the app name and window title
- the nearby text (character count)
- the screenshot (thumbnail)
- any images you pasted or attached (thumbnails)

Click ✕ on any chip to leave it out. Your personality prompt from Settings, if you chose one, goes with each
new conversation. Cards and what you did with them (added, sent, replaced, dismissed) are sent with your next
question. When Kiki scrolls, it sends the text on screen after each step (and a screenshot when the camera is
on).

All of this goes to the Kiki server and then to Claude, Anthropic's AI model, to answer you. The server
keeps a conversation in memory for an hour so follow-ups work, and counts how many questions each invite code
asks per day. Kiki tells Claude to treat what's on your screen as material to read, not as instructions.

Searches Kiki opens in your browser go to Google or YouTube with the query in the link, like any search you
type yourself.

Past sessions (questions, answers and the context they started with, but no screenshots or images) are kept
in `history.json` in Kiki's settings folder, on your computer only. **Clear** in the past sessions list
deletes them.

The screenshot setting is **camera button** on Linux: Kiki takes a screenshot only when you press it. It is
**always** on macOS. You can set it to **never**, which also hides the camera button. With the GNOME helper, the
screenshot covers only the window you were in, around the pointer, not the whole screen.

## Known limitations

- **On GNOME, the popup needs the helper** to open at the pointer. Without it, the popup opens in the middle
  of the screen. Drag the popup by the chat box's top edge or by the toolbar's empty space to move it.
- **The popup stays open until you close it** (the ✕ on the box's corner, or Esc), on top of other windows.
  Clicks in the clear space around the box reach the app underneath. Until you've logged in again after
  installing the GNOME helper, the popup closes when you click outside it or switch apps instead.
- **Answers about the wrong text on Linux:** when an app doesn't share its selection, Kiki uses the last text
  highlighted anywhere. The popup doesn't show the highlighted text, so an answer about different text is the
  sign that this happened.
- **Screenshot permission on GNOME:** without the GNOME helper, GNOME may ask for permission the first time
  Kiki takes a screenshot.
- **Terminals:** Ptyxis and other GTK 4 terminals share only what is on screen. A terminal's text shows up
  once its screen changes after accessibility is on. A window that has printed nothing since then reads as
  empty, so Kiki takes a screenshot instead. When nothing is highlighted in the terminal itself, Kiki ignores text highlighted in
  other windows.
- **Pasted edits go where the cursor is now:** in Google Docs and VS Code, Kiki pastes at the cursor. If you
  clicked somewhere else in that window after opening Kiki, the text goes there, and a highlight that's gone
  isn't replaced.
- **Changes in Google Docs** rely on Docs' Find and replace dialog, as it looks in English. If Docs changes
  that dialog, the card says Kiki couldn't find it, and **Copy** still works.
- **Scrolling needs the window on screen:** Kiki says so when it's minimized, on another workspace or covered
  by other windows. Kiki scrolls less than a full screen at a time, so it never skips past anything.
- **Hotkey delay:** there's about 0.4 s between pressing the hotkey and Kiki reading the window.
