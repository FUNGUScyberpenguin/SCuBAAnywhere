import { defineConfig } from "vite";

export default defineConfig({
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
