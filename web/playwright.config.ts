import { defineConfig } from "@playwright/test";

/**
 * The end-to-end tests run against the built app, because what matters is what
 * the browser actually does with the WebAssembly bundle and the file input.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4178",
    // Honour a Chromium that is already on the machine (CI images often pin one
    // that does not match this Playwright release) and fall back to Playwright's
    // own download otherwise.
    ...(process.env["PLAYWRIGHT_CHROMIUM_PATH"]
      ? { launchOptions: { executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] } }
      : {}),
  },
  webServer: {
    command: "npx vite preview --port 4178 --strictPort",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
