import { defineConfig } from "@playwright/test";

/**
 * The same end-to-end suite against a GitHub Pages build.
 *
 * Pages serves a project repository from `https://<user>.github.io/<repo>/`,
 * not from the root, and an app that quietly assumes the root breaks there in
 * ways that only show up once it is deployed: a stylesheet that 404s, a policy
 * bundle fetched from the wrong path. Building with a base path and running the
 * whole suite under it catches that here instead.
 */
const BASE_PATH = "/SCuBAAnywhere/";
const PORT = 4179;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-pages" }]],
  outputDir: "test-results-pages",
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: "retain-on-failure",
    ...(process.env["PLAYWRIGHT_CHROMIUM_PATH"]
      ? { launchOptions: { executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] } }
      : {}),
  },
  webServer: {
    // Rebuilt here rather than reusing dist/, because the base path is fixed at
    // build time and the root build cannot be re-served under a prefix.
    // Exported, not prefixed: `VAR=x cmd1 && cmd2` sets the variable for cmd1
    // only, and vite preview reads the base from the config at serve time as
    // well as at build time. Without it the preview serves from the root and
    // every hashed asset 404s.
    command:
      `export SCUBA_BASE_PATH=${BASE_PATH}; ` +
      `npx vite build --outDir dist-pages && ` +
      `npx vite preview --outDir dist-pages --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env["CI"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
});
