import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const SW_SOURCE = new URL("./src/sw.js", import.meta.url);
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));

/** The service worker, with the list of the build's files to cache for
 * offline use and a version that changes with every build (so browsers pick
 * up a new release). In development it caches nothing. */
function serviceWorker(): Plugin {
  const render = (files: string[], version: string, dev: boolean) =>
    readFileSync(SW_SOURCE, "utf8")
      .replace("__PRECACHE__", JSON.stringify(files))
      .replace("__VERSION__", JSON.stringify(version))
      .replace("__DEV__", String(dev));
  return {
    name: "tex2html-viewer-sw",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== `${server.config.base}sw.js`) return next();
        res.setHeader("Content-Type", "text/javascript");
        res.end(render([], "dev", true));
      });
    },
    generateBundle(_options, bundle) {
      // the bundle, plus public/ (copied as is, so not in the bundle)
      const pub = (readdirSync(PUBLIC, { recursive: true, withFileTypes: true }))
        .filter((d) => d.isFile())
        .map((d) => relative(PUBLIC, join(d.parentPath, d.name)).split("\\").join("/"));
      const files = ["./", ...Object.keys(bundle).filter((f) => !f.endsWith(".map")), ...pub].sort();
      const hash = createHash("sha256");
      for (const f of files) {
        const b = bundle[f];
        if (b) hash.update(b.type === "chunk" ? b.code : b.source);
        else if (f !== "./") hash.update(readFileSync(join(PUBLIC, f)));
      }
      this.emitFile({ type: "asset", fileName: "sw.js",
                      source: render(files, hash.digest("hex").slice(0, 12), false) });
    },
  };
}

// BASE: "/" locally, "/tex2html-viewer/" on GitHub Pages
export default defineConfig({
  base: process.env.BASE ?? "/",
  plugins: [serviceWorker()],
});
