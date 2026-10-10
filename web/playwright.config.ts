import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5179", channel: "chrome", headless: true },
  webServer: {
    command: "npx vite --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: true,
  },
});
