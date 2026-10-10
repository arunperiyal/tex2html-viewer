# tex2html viewer — plan

An app for opening packed tex2html decks and showing them as slides, on Android
and on the web.

It is made for decks produced by tex2html (`--pack` zips), not as a general
HTML viewer. The first goal is one job done well: open a pack and present it,
exactly as a desktop browser shows `slides.html`. Modes (presenter, audience,
shared viewing) are for later. To show the slides to others — in a call, on a
projector, on a TV — the user shares or mirrors their screen with whatever they
already use (Meet, Zoom, Teams, Android screen cast, a cable to a projector).
The viewer adds no sharing of its own.

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
5. To show it to others, share or mirror the screen with the usual tools.

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

- **Web:** the zip is read in the browser (streamed unzip), files go to the
  Origin Private File System, and a **service worker** answers requests for
  `/decks/<id>/…` from it. The app itself is cached by the service worker, so it
  starts offline after the first visit. It asks for persistent storage, so the
  browser does not clear large decks.
- **Android:** a WebView shows the same web app, bundled in the APK. Import and
  storage are native (faster for large zips, no browser storage limits): files
  are unpacked to the app's internal storage under `decks/<id>/` and served with
  `WebViewAssetLoader` under `https://appassets.androidplatform.net/`. A small
  JavaScript bridge lets the web code list, import and delete decks.
- A storage interface in the web code hides the difference: `listDecks`,
  `importZip`, `deleteDeck`, `deckUrl`.

### Import

- Web: file picker or drag and drop. Android: system file picker, "Open with",
  and the share menu (`application/zip`).
- Find the deck in the zip: one folder with `slides.html` (what `--pack`
  writes), or `slides.html` at the root.
- Stream with progress and cancel; check free space first; reject unsafe
  entries (absolute paths, `..`, symlinks); unpack to a temporary place and
  swap it in at the end, so a failed import never leaves half a deck.
- Re-importing a deck with the same name offers to replace it.

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

### Working with tex2html

- The viewer needs nothing from tex2html beyond what `--pack` writes today, so
  it opens any existing pack.
- Two small deck.js changes, made in the tex2html repo, make it nicer; the
  viewer works without them and uses them when present:
  - keep `location.hash` (`#slide.step`) updated while navigating, so the
    viewer (and a desktop reload) can resume where the talk was;
  - hide the presenter-view hint (`S`) where a second window cannot open, as
    inside the app.
- tex2html's README gets a short section pointing to the viewer.
- Test packs in `fixtures/` are made from tex2html's template deck with
  `--pack`; a script rebuilds them from a tex2html checkout when deck.js
  changes.

## Project setup

- Location: its own repository, `tex2html-viewer`. tex2html stays the
  converter; the viewer has its own releases, issues and GitHub Pages site.
- **Web:** TypeScript and Vite, no UI framework needed for two screens; `fflate`
  for streamed unzip; Playwright for browser tests. Hosted on the repo's GitHub
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
  keys, rotation, screen off/on, back button, resume, and the deck shown through
  a screen share and a screen cast.
- The real talk (~680 MB): import time and memory, on Android and in a mobile
  browser.

## Milestones

Each milestone ends with something usable.

1. **M0 – a pack shows as slides.** The repo, the web app's skeleton and the
   fixture pack: import the template pack in a desktop browser and Chrome on
   Android, and every slide works (steps, MathJax, animations, TikZ). This is
   the first challenge; everything else builds on it.
2. **M1 – web viewer.** Library, full-screen viewer, keys, resume, offline after
   the first visit; deployed to GitHub Pages. In tex2html: the deck.js hash and
   presenter-hint changes.
3. **M2 – Android app.** The same web code in a WebView, with native import and
   storage, "Open with" and the share menu, immersive full screen, keys,
   clicker and volume keys, back guard.
4. **M3 – large decks and release.** Performance with the 680 MB talk on both
   platforms, signed APK, README section in tex2html.

## Later

- **Modes:** presenter, audience and shared viewing between devices — to be
  designed once viewing works.
- Presenter view on a phone or tablet with an external display (HDMI or
  USB-C): slides on the display, notes, timer and next slide on the device.
- Import an unzipped folder, for decks copied without zipping.
- Play Store or F-Droid publishing.

## Decisions

- The name is **tex2html viewer** for now.
- The first goal is viewing: open a pack and present it. Showing the slides to
  others is done with the user's existing screen-share or mirroring tools;
  modes are for later.
- Targets: web (GitHub Pages) and Android, from one web codebase.
- The viewer has its own repository, `tex2html-viewer`.
