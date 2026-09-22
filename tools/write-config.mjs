#!/usr/bin/env node
// Write web/public/config.json from environment variables.
//
// Every value here is public: both OAuth clients are public clients with no
// secret, because a secret shipped to a browser is not a secret. That is what
// makes a static host workable at all, and it is why these come from repository
// variables rather than repository secrets.
//
// With nothing set, the file still gets written with live collection off. The
// page then evaluates a settings export you already have, which needs no OAuth
// client at all.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "web/public/config.json");

const env = process.env;
const ENVIRONMENTS = new Set(["commercial", "gcc", "gcchigh", "dod"]);

const provided = [
  "SCUBA_MS_CLIENT_ID", "SCUBA_MS_AUTHORITY", "SCUBA_M365_ENVIRONMENT",
  "SCUBA_GOOGLE_CLIENT_ID", "SCUBA_GOOGLE_CUSTOMER_ID",
  "SCUBA_RELAY_URL", "SCUBA_DNS_ENABLED", "SCUBA_DNS_RESOLVER",
].filter((name) => (env[name] ?? "").trim() !== "");

// Nothing to go on and a config already in place: leave it. This is the local
// case where someone wrote their own config.json by hand.
if (provided.length === 0 && existsSync(outPath)) {
  console.log(`config: keeping the existing ${outPath} (no SCUBA_* variables set)`);
  process.exit(0);
}

const environment = (env["SCUBA_M365_ENVIRONMENT"] ?? "commercial").trim();
if (!ENVIRONMENTS.has(environment)) {
  throw new Error(`SCUBA_M365_ENVIRONMENT is "${environment}"; expected one of ${[...ENVIRONMENTS].join(", ")}`);
}

const relayUrl = (env["SCUBA_RELAY_URL"] ?? "").trim().replace(/\/+$/, "");
if (relayUrl && !/^https:\/\//.test(relayUrl)) {
  throw new Error(`SCUBA_RELAY_URL is "${relayUrl}"; it must be an https URL`);
}

const dnsEnabled = /^(1|true|yes)$/i.test((env["SCUBA_DNS_ENABLED"] ?? "").trim());
const resolverUrl = (env["SCUBA_DNS_RESOLVER"] ?? "https://cloudflare-dns.com/dns-query").trim();

const config = {
  microsoft: {
    clientId: (env["SCUBA_MS_CLIENT_ID"] ?? "").trim(),
    authority: (env["SCUBA_MS_AUTHORITY"] ?? "https://login.microsoftonline.com/organizations").trim(),
    environment,
  },
  google: {
    clientId: (env["SCUBA_GOOGLE_CLIENT_ID"] ?? "").trim(),
    customerId: (env["SCUBA_GOOGLE_CUSTOMER_ID"] ?? "my_customer").trim(),
  },
  relayUrl,
  dns: { enabled: dnsEnabled, resolverUrl },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");

/**
 * The origins the page's Content-Security-Policy has to allow beyond the
 * built-in Microsoft and Google ones. Printed as a GitHub Actions output so the
 * build step can pass them to Vite, and to stdout so a manual build can too.
 */
const connectSrc = [relayUrl, dnsEnabled ? originOf(resolverUrl) : ""].filter(Boolean);
if (env["GITHUB_OUTPUT"]) {
  writeFileSync(env["GITHUB_OUTPUT"], `connect-src=${connectSrc.join(" ")}\n`, { flag: "a" });
}

const described = provided.length > 0 ? provided.join(", ") : "no SCUBA_* variables";
console.log(`config: wrote ${outPath} from ${described}`);
console.log(`  microsoft: ${config.microsoft.clientId ? "configured" : "off"} (${environment})`);
console.log(`  google:    ${config.google.clientId ? "configured" : "off"}`);
console.log(`  relay:     ${relayUrl || "none, so only Entra ID and Google Workspace can be collected live"}`);
console.log(`  dns:       ${dnsEnabled ? resolverUrl : "off, so SPF, DKIM and DMARC report as not evaluated"}`);
if (connectSrc.length > 0) console.log(`  extra connect-src: ${connectSrc.join(" ")}`);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`SCUBA_DNS_RESOLVER is "${url}", which is not a URL`);
  }
}
