# tex2html viewer

Shows decks made with [tex2html](https://github.com/arunperiyal/tex2html) as
slides, on Android and on the web: open a `--pack` zip and present it full
screen, offline.

Work in progress — see [PLAN.md](PLAN.md).

## Development (web)

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # Playwright, with the installed Chrome, on a production build
npm run build      # static files in web/dist
```

Decks are kept as their zip in the browser's private file storage (OPFS),
with an index of where each file is. The service worker (`web/src/sw.js`,
built by `vite.config.ts` with the list of files to cache) serves
`decks/<folder>/…` by reading the file out of the zip, so a deck's relative
paths resolve without unpacking anything, and caches the app so it starts
offline. Service workers need
`https://` or `localhost`.

`fixtures/template.zip` is tex2html's template deck, packed. Rebuild it from a
tex2html checkout with `scripts/make-fixtures.sh ../tex2html`.

## Development (Android)

The Android app (`android/`) shows the same web app in a WebView: the build
bundles `web/` (built with base `/`) into the APK, served under
`https://appassets.androidplatform.net/`. Decks are kept natively
(`DeckStore.kt`: the zip copied into the app's files, served under
`native/<id>/` with `ZipFile`). It adds the system file picker,
"Open with" and the share menu for zips, immersive full screen in landscape
with the screen kept on, Back through the deck's guard, and the volume keys
for previous / next.

```sh
cd android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew assembleDebug   # needs a full JDK 17+
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Set `sdk.dir` in `android/local.properties` (or `ANDROID_HOME`) to the Android
SDK. GitHub Actions builds the debug APK on every push (artifact
`tex2html-viewer-debug-apk`).

### Releases

Release APKs are shrunk (R8) and signed with the release key, which is kept
outside the repo; `scripts/release-apk.sh` builds one and checks the
signature (see the script for the Gradle properties it needs). Every release
must be signed with the same key, or it will not install over the previous
one. Release APKs are published on the
[releases page](https://github.com/arunperiyal/tex2html-viewer/releases).

