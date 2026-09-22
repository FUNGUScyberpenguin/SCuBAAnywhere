import { defineConfig, type Plugin } from "vite";

/**
 * Where the app will be served from.
 *
 * GitHub Pages for a project repository serves at
 * `https://<user>.github.io/<repo>/`, so the built asset URLs need that prefix.
 * Everything the app fetches at runtime (config.json, the policy bundles, the
 * baselines) is requested relative to the page, so only Vite's own output needs
 * telling.
 */
const base = process.env["SCUBA_BASE_PATH"] ?? "/";

/**
 * Origins the page may talk to beyond the built-in Microsoft and Google ones:
 * a relay, and a DNS-over-HTTPS resolver if the DNS checks are turned on.
 *
 * These have to be baked in at build time. The policy lives in a meta tag
 * because a static host cannot set response headers, and a meta tag is read
 * once when the document parses; adding an origin at runtime is not possible,
 * which is the point.
 */
const extraConnectSrc = (process.env["SCUBA_CONNECT_SRC"] ?? "")
  .split(/[\s,]+/)
  .filter(Boolean);

/** Substitute the connect-src placeholder in index.html. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "scuba-csp",
    transformIndexHtml(html) {
      for (const origin of extraConnectSrc) {
        if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
          throw new Error(
            `SCUBA_CONNECT_SRC contains "${origin}", which is not an https origin. ` +
              `Give origins only, e.g. https://relay.example.gov`,
          );
        }
      }
      const replacement = extraConnectSrc.length > 0 ? ` ${extraConnectSrc.join(" ")}` : "";
      return html.replace("%SCUBA_EXTRA_CONNECT_SRC%", replacement);
    },
  };
}

export default defineConfig({
  base,
  plugins: [contentSecurityPolicy()],
  build: {
    target: "es2022",
    // Assessment data only ever exists in memory, so there is nothing to gain
    // from inlining assets; keep the policy bundles as separate cacheable files.
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  server: {
    headers: {
      "Cache-Control": "no-store",
    },
  },
});
