import { defineConfig } from "@playwright/test";

/**
 * The end-to-end tests run against the built app, because what matters is what
 * the browser actually does with the WebAssembly bundle and the file input.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Playwright writes no HTML report unless asked, so CI's artifact upload had
  // nothing to collect on the one failure it was there for.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4178",
    trace: "retain-on-failure",
    // Honour a Chromium that is already on the machine (CI images often pin one
    // that does not match this Playwright release) and fall back to Playwright's
    // own download otherwise.
    ...(process.env["PLAYWRIGHT_CHROMIUM_PATH"]
      ? { launchOptions: { executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] } }
      : {}),
  },
  webServer: {
    // --host is load-bearing. Without it vite binds to whatever "localhost"
    // resolves to, which on a dual-stack CI runner is ::1, while the url below
    // is IPv4. The server comes up fine and Playwright waits for it on an
    // address nothing is listening on.
    command: "npx vite preview --host 127.0.0.1 --port 4178 --strictPort",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: !process.env["CI"],
    // Piped, so a server that fails to start says why instead of timing out
    // silently.
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
});
