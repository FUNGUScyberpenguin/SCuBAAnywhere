#!/usr/bin/env node
// Compile CISA's Rego baselines into WebAssembly bundles the browser can run.
//
// One bundle per suite, with one entrypoint per product (data.<product>.tests),
// which is the same entrypoint ScubaGear and ScubaGoggles evaluate natively.
// Output lands in web/public/policies/ and is never committed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const checksums = JSON.parse(readFileSync(join(root, "tools/opa-checksums.json"), "utf8"));

const SUITES = [
  {
    id: "m365",
    source: "scubagear",
    regoDir: join(root, "vendor/scubagear", upstream.scubagear.paths.rego),
    products: ["aad", "defender", "exo", "powerbi", "powerplatform", "securitysuite", "sharepoint", "teams"],
  },
  {
    id: "gws",
    source: "scubagoggles",
    regoDir: join(root, "vendor/scubagoggles", upstream.scubagoggles.paths.rego),
    products: [
      "assuredcontrols", "calendar", "chat", "classroom", "commoncontrols",
      "drive", "gemini", "gmail", "groups", "meet", "sites",
    ],
  },
];

async function ensureOpa() {
  const version = upstream.opa.version;
  const key = `${process.platform}-${process.arch}`;
  const spec = checksums[version]?.[key];
  if (!spec) {
    throw new Error(
      `No pinned OPA ${version} build for ${key}. Add its sha256 to tools/opa-checksums.json, ` +
        `or put an OPA ${version} binary at tools/bin/opa yourself.`,
    );
  }

  const binDir = join(root, "tools/bin");
  const exe = join(binDir, process.platform === "win32" ? "opa.exe" : "opa");
  if (existsSync(exe) && sha256(readFileSync(exe)) === spec.sha256) return exe;

  mkdirSync(binDir, { recursive: true });
  const url = `${upstream.opa.downloadBase}/${version}/${spec.asset}`;
  console.log(`opa: downloading ${version} for ${key}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`opa: ${url} returned HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const got = sha256(bytes);
  if (got !== spec.sha256) {
    throw new Error(`opa: checksum mismatch for ${spec.asset}\n  expected ${spec.sha256}\n  got      ${got}`);
  }
  writeFileSync(exe, bytes);
  chmodSync(exe, 0o755);
  console.log(`opa: verified ${spec.asset}`);
  return exe;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Minimal ustar reader. OPA writes bundle members with a leading slash, so
// names are normalised; only regular files are kept.
function readTar(buf) {
  const members = new Map();
  for (let offset = 0; offset + 512 <= buf.length; ) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/[\0 ]/g, ""), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (typeflag === "0" || typeflag === "\0") {
      members.set(name.replace(/^\.?\/+/, ""), buf.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return members;
}

function build(opa, suite, outDir) {
  if (!existsSync(suite.regoDir)) {
    throw new Error(`${suite.id}: Rego sources missing at ${suite.regoDir}. Run \`npm run vendor\` first.`);
  }
  const tarball = join(outDir, "bundle.tar.gz");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const args = ["build", "-t", "wasm"];
  for (const product of suite.products) args.push("-e", `${product}/tests`);
  args.push("-o", tarball, ".");
  execFileSync(opa, args, { cwd: suite.regoDir, stdio: "inherit" });

  // The bundle is a gzipped tar; the browser only needs policy.wasm and the
  // bundle's static data. Everything else in it is Rego source.
  const members = readTar(gunzipSync(readFileSync(tarball)));
  rmSync(tarball);
  const wasm = members.get("policy.wasm");
  if (!wasm) throw new Error(`${suite.id}: opa produced no policy.wasm`);
  writeFileSync(join(outDir, "policy.wasm"), wasm);
  writeFileSync(join(outDir, "data.json"), members.get("data.json") ?? Buffer.from("{}\n"));

  console.log(`${suite.id}: ${suite.products.length} entrypoints, ${(wasm.length / 1024).toFixed(0)} KiB wasm`);
  return { bytes: wasm.length, sha256: sha256(wasm) };
}

const opa = await ensureOpa();
const policiesDir = join(root, "web/public/policies");
mkdirSync(policiesDir, { recursive: true });

const manifest = { builtAt: new Date().toISOString(), opaVersion: upstream.opa.version, suites: {} };
for (const suite of SUITES) {
  const built = build(opa, suite, join(policiesDir, suite.id));
  manifest.suites[suite.id] = {
    source: suite.source,
    upstreamRef: upstream[suite.source].ref,
    upstreamCommit: upstream[suite.source].commit,
    products: suite.products,
    ...built,
  };
}
writeFileSync(join(policiesDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${join(policiesDir, "manifest.json")}`);
