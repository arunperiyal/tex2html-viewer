import { defineConfig } from "vite";

// BASE: "/" locally, "/tex2html-viewer/" on GitHub Pages
export default defineConfig({
  base: process.env.BASE ?? "/",
});
