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
npm test           # Playwright, with the installed Chrome
npm run build      # static files in web/dist
```

Decks are imported into the browser's private file storage (OPFS); the
service worker (`web/public/sw.js`) serves `decks/<folder>/…` from there, so
the deck's relative paths resolve. Service workers need `https://` or
`localhost`.

`fixtures/template.zip` is tex2html's template deck, packed. Rebuild it from a
tex2html checkout with `scripts/make-fixtures.sh ../tex2html`.
