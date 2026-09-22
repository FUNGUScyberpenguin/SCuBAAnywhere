#!/usr/bin/env node
// Prove the browser engine agrees with the reference implementation.
//
// Evaluates CISA's sample settings export twice: once with the OPA binary the
// way ScubaGear does it, once with the WebAssembly bundle the way the browser
// does it. Any difference is a bug in this project, not in the baselines.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import { REGO_BUILTINS } from "../packages/core/dist/opa/builtins.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const regoDir = join(root, "vendor/scubagear", upstream.scubagear.paths.rego);
const samplePath = join(root, "vendor/scubagear", upstream.scubagear.paths.sampleExport);
const opa = join(root, "tools/bin", process.platform === "win32" ? "opa.exe" : "opa");

for (const [label, path] of [["Rego sources", regoDir], ["sample export", samplePath], ["OPA binary", opa]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${label} at ${path}. Run \`npm run vendor && npm run policies\` first.`);
    process.exit(2);
  }
}

const PRODUCTS = ["aad", "defender", "exo", "powerbi", "powerplatform", "securitysuite", "sharepoint", "teams"];
const sampleJson = readFileSync(samplePath, "utf8").replace(/^﻿/, "");
const sample = JSON.parse(sampleJson);

const bundleDir = join(root, "web/public/policies/m365");
const policy = await loadPolicy(readFileSync(join(bundleDir, "policy.wasm")), undefined, REGO_BUILTINS);
policy.setData(JSON.parse(readFileSync(join(bundleDir, "data.json"), "utf8")));

// opa eval reads input from a file; reuse the de-BOM'd copy the engine sees.
const inputFile = join(root, "vendor/.parity-input.json");
const { writeFileSync, rmSync } = await import("node:fs");
writeFileSync(inputFile, sampleJson);

/** Stable serialisation with object keys sorted. Array order is preserved. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Same, but array order is ignored.
 *
 * Several baselines build their ActualValue from a Rego set. A set has no
 * order, and the two runtimes iterate one differently: the OPA binary emits
 * members sorted, the WebAssembly runtime emits them in its own internal order.
 * The members are the same, and so is the verdict, so this is presentation
 * rather than a difference in what the policy decided.
 */
function unordered(value) {
  if (Array.isArray(value)) return `[${value.map(unordered).sort().join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${unordered(value[key])}`);
  return `{${entries.join(",")}}`;
}

/** The fields that decide what a report says about a policy. */
const verdictOf = (r) => canonical({
  PolicyId: r.PolicyId,
  RequirementMet: r.RequirementMet,
  Criticality: r.Criticality,
  Commandlet: r.Commandlet ?? null,
  NoSuchEvent: r.NoSuchEvent ?? null,
});

let failed = 0;
try {
  for (const product of PRODUCTS) {
    const nativeRaw = execFileSync(
      opa,
      ["eval", "-i", inputFile, "-d", regoDir, "-f", "values", `data.${product}.tests`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(nativeRaw);
    const native = Array.isArray(parsed[0]) ? parsed[0] : parsed;
    const wasm = policy.evaluate(sample, `${product}/tests`)[0].result;

    // `opa eval` emits object keys sorted; the WebAssembly SDK hands back plain
    // JavaScript objects in insertion order. Compare canonically so key order
    // is not mistaken for a difference in the verdicts.
    const key = (results) =>
      canonical([...results].sort((a, b) => a.PolicyId.localeCompare(b.PolicyId)));

    if (key(native) === key(wasm)) {
      console.log(`${product.padEnd(15)} ok  ${native.length} results`);
      continue;
    }

    const nativeById = new Map(native.map((r) => [r.PolicyId, r]));
    const real = [];
    const reordered = [];
    for (const result of wasm) {
      const other = nativeById.get(result.PolicyId);
      if (!other) { real.push([result.PolicyId, "only in the WebAssembly result", result, null]); continue; }
      nativeById.delete(result.PolicyId);
      if (canonical(other) === canonical(result)) continue;

      const sameVerdict = verdictOf(other) === verdictOf(result);
      const sameMembers = unordered(other.ActualValue ?? null) === unordered(result.ActualValue ?? null);
      if (sameVerdict && sameMembers) { reordered.push(result.PolicyId); continue; }
      real.push([result.PolicyId, sameVerdict ? "ActualValue differs" : "verdict differs", result, other]);
    }
    for (const [id] of nativeById) real.push([id, "missing from the WebAssembly result", null, null]);

    if (real.length === 0) {
      console.log(
        `${product.padEnd(15)} ok  ${native.length} results ` +
          `(${reordered.length} with set members in a different order)`,
      );
      continue;
    }

    failed += 1;
    console.error(`${product.padEnd(15)} MISMATCH  native ${native.length} / wasm ${wasm.length}`);
    for (const [id, why, result, other] of real) {
      console.error(`  ${id}: ${why}`);
      if (other) console.error(`    native: ${canonical(other).slice(0, 400)}`);
      if (result) console.error(`    wasm:   ${canonical(result).slice(0, 400)}`);
    }
  }
} finally {
  rmSync(inputFile, { force: true });
}

if (failed > 0) {
  console.error(`\n${failed} product(s) differ from the reference implementation.`);
  process.exit(1);
}
console.log("\nThe browser engine matches the OPA binary on every product.");
