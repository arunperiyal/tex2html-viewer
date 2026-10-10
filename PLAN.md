# tex2html viewer — plan

An app for opening packed tex2html decks and showing them as slides, on Android
and on the web.

It is made for decks produced by tex2html (`--pack` zips), not as a general
HTML viewer. The first goal is one job done well: open a pack and present it,
exactly as a desktop browser shows `slides.html`. Modes (presenter, audience,
shared viewing) are for later. To show the slides to others — in a call, on a
projector, on a TV, or on the audience's own devices — the user shares or
mirrors their screen with tools made for it (see Showing the slides to
others). The viewer adds no sharing of its own.

## Why

`slides.html` loads `html/deck.css`, `html/deck.js`, MathJax, figures and
animation frames from the folders next to it. Opening the file directly on a
phone (and sometimes on a desktop) breaks those relative paths, so the deck
shows as plain text. A viewer that stores the deck's files and serves them to
the page under one origin makes every pack work the same everywhere, offline
once it is imported.

## How it is used

1. Make a pack on the computer: `python3 path/to/tex2html --pack`.
2. Get the zip onto the device (USB, Drive, mail, a download).
3. Open it in tex2html viewer: the deck is imported into the app's library.
4. Tap the deck: it opens full screen, ready to present with swipe, tap,
   keyboard or a Bluetooth clicker.
5. To show it to others, share or mirror the screen (see below).

## Showing the slides to others

The viewer keeps the screen clean (nothing over the slides), so any mirroring
tool shows just the deck:

- **The audience's own phones and laptops:** **ScreenStream** (open source, on
  the presenting Android phone) mirrors the screen to any browser, video only.
  Local mode works over the room's Wi-Fi or the phone's hotspot with no
  internet: the audience scans a QR code or opens a link. Global mode works
  over the internet with a stream ID and password. The phone sends a stream to
  each viewer, so it suits small to medium groups; turn on Do Not Disturb so
  notifications are not mirrored.
- **A projector or TV:** a USB-C to HDMI cable (phones with video output),
  Android Cast or Screen mirroring (Chromecast, Google TV, Miracast), or
  scrcpy to a laptop connected to the projector.
- **A remote meeting:** sharing the screen in Meet, Zoom or Teams.

## Goals

- One viewer for **web** (an installable web app, for desktop and mobile
  browsers) and **Android** (an app), sharing one codebase for the screens.
- Import a `--pack` zip; keep a library of decks; open one with a tap.
- Everything in a deck works as in a desktop browser: steps and overlays,
  MathJax, slide tables, animations, TikZ diagrams, citations, touch navigation.
- Works offline once a deck is imported.
- Looks right when the screen is shared: the slides fill the screen, with no app
  controls on top of them.
- Handles large decks (the current talk is ~680 MB of animation frames).

## Non-goals

- Viewing arbitrary HTML sites.
- Sharing, casting or syncing between devices: the user's existing screen-share
  and mirroring tools do that.
- Editing slides or running tex2html on the device.
- A native iOS app (the web app covers iPhones and iPads in Safari).

## Architecture

A separate repository, `tex2html-viewer`:

```
tex2html-viewer/
  web/        the app: library and viewer (TypeScript, built to static files)
  android/    Android app around web/ (Kotlin, WebView)
  fixtures/   test packs made with tex2html (the template deck)
```

### The deck inside the app

- The app shows a deck in a full-screen `<iframe>` served from storage under the
  app's own origin, so relative paths resolve and deck.js runs unchanged.
- The app reads the current slide and step from the deck's URL (`#slide.step`)
  to resume a deck where it was left.

### Storage, per platform

A deck is kept as its zip and read from it: a pack's index (the zip's central
directory) says where each file is, and its images are stored uncompressed,
so a requested file is read straight out of the zip. Nothing is unpacked: an
import is one sequential copy, and a deck takes its zip's size once. (The
first version unpacked about 1,500 files per deck; a 700 MB talk took 15
minutes to import in the Android app. Read from the zip, it takes seconds.)

- **Web:** the zip is copied into the Origin Private File System as one file
  (`decks/<folder>/pack.zip`, plus `index.json`: where each file is), and a
  **service worker** answers requests for `decks/<folder>/…` by reading the
  entry from the zip (stored entries as they are, deflated ones through
  `DecompressionStream`). Decks unpacked by the first version are still
  served. The app itself is cached by the service worker, so it starts
  offline after the first visit. It asks for persistent storage, so the
  browser does not clear large decks.
- **Android:** a WebView shows the same web app, bundled in the APK and served
  with `WebViewAssetLoader` under `https://appassets.androidplatform.net/`.
  Decks are kept natively (`DeckStore`): the zip is copied into the app's
  files once and served under `native/<id>/…` with `ZipFile`, so deck bytes
  never pass through the page (handing a 700 MB zip to the page took
  minutes, or failed). The page lists, opens and deletes decks through the
  bridge and shows the import's progress. Zips picked in the system picker,
  opened with the app or shared to it are imported the same way.

### Import

A zip is one file, easy to move by Drive, mail or USB, and importing it is
mostly a copy (a pack's images are stored uncompressed).

- Web: file picker or drag and drop. Android: system file picker, "Open with",
  and the share menu (`application/zip`).
- Find the deck in the zip: one folder with `slides.html` (what `--pack`
  writes), or `slides.html` at the root.
- Copy with progress and cancel; check free space first; reject unsafe
  entries (absolute paths, `..`, symlinks); the deck is recorded only once the
  copy is complete, so a failed or cancelled import never leaves half a deck.
- Re-importing a deck with the same name replaces it once the new copy is
  complete (its saved position is kept).

### Library screen

- Decks with title (the page's `<title>`), size and import date; newest first.
- Open, delete, replace with a newer pack.
- When empty: how to make a pack and import it.

### Viewer screen

- Full screen (immersive on Android, the Fullscreen API on the web), landscape
  by default on phones, screen kept on while a deck is open.
- Nothing drawn over the slides, so a shared or mirrored screen shows only the
  deck. A tap in a corner (or Esc) brings up a small bar to leave the deck.
- Keys go straight to deck.js: arrows, PageUp/PageDown, Space, Home/End and
  clicker buttons; on Android, the volume keys as previous/next (a setting).
- Android back button: a second press closes the deck, so a stray press does
  not end a talk.
- Resume: reopen a deck at the last slide and step.
- Speaker notes on a toggle: the Notes button in the bar (or N) shows the
  current slide's notes (`\note{...}`) in a panel at the bottom, following the
  slides. Off whenever a deck opens; anyone who sees the screen sees them
  (mirroring, casting), which the viewer says the first time. A presenter view
  with a second screen (slides on a projector, notes on the phone) is under
  Later.

### Working with tex2html

- The viewer needs nothing from tex2html beyond what `--pack` writes today, so
  it opens any existing pack.
- deck.js already keeps `location.hash` (`#slide.step`) updated while
  navigating; the viewer reads it to resume a deck where it was left.
- `slides.html?nopresenter` (deck.js, added in M2): the Android app opens decks
  this way, so the presenter view, which cannot open there, is left out of the
  help and S does nothing. Older packs simply show it.
- tex2html's README points phones and tablets to the viewer (added in M2).
- Test packs in `fixtures/` are made from tex2html's template deck with
  `--pack`; a script rebuilds them from a tex2html checkout when deck.js
  changes.

## Project setup

- Location: its own repository, `tex2html-viewer`. tex2html stays the
  converter; the viewer has its own releases, issues and GitHub Pages site.
- **Web:** TypeScript and Vite, no UI framework and no runtime dependencies (the
  zip reader is our own, using the browser's `DecompressionStream`); Playwright
  for browser tests. Hosted on the repo's GitHub
  Pages site, installable from the browser, built and deployed by a GitHub
  Actions workflow.
- **Android:** Kotlin, Gradle Kotlin DSL, one `app` module, `androidx.webkit`
  for `WebViewAssetLoader`. The web build is copied into the APK's assets. Needs
  JDK 17 (this machine has JDK 11: install `openjdk-17-jdk` or use Android
  Studio's bundled JDK); SDK at `~/Android/Sdk`, `adb` available. Debug builds
  with `./gradlew assembleDebug`, installed with `adb install -r`; the release
  APK is signed with our own keystore (kept out of git) and attached to GitHub
  releases.
- **iPhone and iPad (web):** best effort. Safari limits storage and may clear
  data of sites that are not installed and not used for a while, so large decks
  may not fit or stay; the viewer warns when storage is short.

## Testing

- Unit: deck detection in zips, unsafe entries, replace and cancel, the storage
  interface.
- Browser (Playwright): import the template's pack, every slide renders
  (deck.js loaded, MathJax typeset, TikZ images present, animations play),
  keys and steps work, resume works; then the same offline.
- Android: an instrumented test importing the template pack; a manual checklist
  on a real phone in airplane mode: every slide type, swipe/tap, clicker, volume
  keys, rotation, screen off/on, back button, resume, and the deck mirrored
  with ScreenStream and shown through a screen cast.
- The real talk (~680 MB): import time and memory, on Android and in a mobile
  browser.

## Milestones

Each milestone ends with something usable.

1. **M0 – a pack shows as slides.** *Done.* The repo, the web app's skeleton and
   the fixture pack: import the template pack in a desktop browser and Chrome on
   Android, and every slide works (steps, MathJax, animations, TikZ); deployed
   to GitHub Pages.
2. **M1 – web viewer.** *Done.* Library, full-screen viewer (landscape on
   phones, screen kept on, controls only on Esc or a tap in the corner), keys,
   resume, back-button guard, offline after the first visit, installable,
   persistent-storage status. Known: in Chrome on Android, the first Back after leaving full
   screen is swallowed by Chrome, so closing a deck from full screen takes one
   more press (the Android app handles Back itself).
3. **M2 – Android app.** *Done.* The same web code in a WebView: the system
   file picker, "Open with" and the share menu, immersive full screen in
   landscape with the screen kept on, keys and clicker, volume keys as
   previous / next, Back through the page's guard (handled natively, so the
   Chrome quirk does not apply), links in a deck opened in the browser, no
   internet permission. Debug APK built by GitHub Actions. In tex2html:
   `slides.html?nopresenter` hides the presenter view, which cannot open in
   the app.
4. **M3 – large decks and release.** Large decks: *done* (read from the zip;
   a 700 MB pack imports in about 2 s on the emulator and in desktop Chrome,
   frames are served in a few milliseconds) — to confirm on a real phone.
   Signed release APK.

## Later

- **Modes:** presenter, audience and shared viewing between devices — to be
  designed once viewing works.
- Presenter view on a phone or tablet with an external display (HDMI or
  USB-C): slides on the display, notes, timer and next slide on the device.
- Play Store or F-Droid publishing.

## Decisions

- The name is **tex2html viewer** for now.
- The first goal is viewing: open a pack and present it. Showing the slides to
  others is done with mirroring tools — ScreenStream for the audience's own
  devices; modes are for later.
- Targets: web (GitHub Pages) and Android, from one web codebase.
- The viewer has its own repository, `tex2html-viewer`.
- Decks come in as zips. Opening a folder in place was tried in M1 and
  dropped: zips are enough.
