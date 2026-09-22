#!/usr/bin/env node
// Normalise CISA's baseline documents into one JSON file per suite.
//
// ScubaGear ships machine-readable baselines (schemas/ScubaBaselines.json);
// ScubaGoggles ships Markdown. The web report needs the same fields either way:
// the policy's name, why it exists, how severe it is, and how to fix it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const outDir = join(root, "web/public/baselines");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));

function buildM365() {
  const spec = upstream.scubagear;
  const src = readJson(join(root, "vendor/scubagear", spec.paths.baselines));
  const policies = {};
  for (const [product, entries] of Object.entries(src.baselines)) {
    for (const entry of entries) {
      policies[entry.id] = {
        id: entry.id,
        product,
        name: entry.name,
        section: entry.policySection ?? "",
        sectionDescription: entry.sectionDescription ?? "",
        rationale: entry.rationale ?? "",
        criticality: (entry.criticality ?? "").toUpperCase(),
        lastModified: entry.lastModified ?? "",
        implementation: entry.implementation ?? "",
      };
    }
  }
  return { suite: "m365", version: src.Version ?? "", source: srcRef(spec), policies };
}

const srcRef = (spec) => ({ repo: spec.repo, ref: spec.ref, commit: spec.commit });

// ScubaGoggles baseline Markdown is regular enough to parse directly:
//   ## <n>. <section title>
//   #### GWS.<PRODUCT>.<n>.<n>v<n>
//   <policy statement>
//   - _Rationale:_ <text>
//   - _Last modified:_ <text>
//   #### GWS.<PRODUCT>.<n>.<n>v<n> Instructions
//   <remediation steps>
const POLICY_ID = /^#{3,4}\s+(GWS\.[A-Z]+(?:\.\d+){2}v\d+)\s*(Instructions)?\s*$/;
const SECTION = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/;

function parseGwsBaseline(markdown, product) {
  const lines = markdown.split(/\r?\n/);
  const policies = {};
  let section = "";
  let current = null;
  let instructionsFor = null;

  const finishStatement = (entry) => {
    entry.name = entry.nameLines.join(" ").trim();
    delete entry.nameLines;
    const shall = /\bSHALL NOT\b|\bSHALL\b/.test(entry.name);
    entry.criticality = shall ? "SHALL" : /\bSHOULD\b/.test(entry.name) ? "SHOULD" : "MAY";
  };

  for (const line of lines) {
    const idMatch = line.match(POLICY_ID);
    if (idMatch) {
      const [, id, isInstructions] = idMatch;
      if (current) finishStatement(current);
      if (isInstructions) {
        current = null;
        instructionsFor = id;
        policies[id] ??= blankPolicy(id, product, section);
      } else {
        instructionsFor = null;
        current = policies[id] ??= blankPolicy(id, product, section);
        current.nameLines ??= [];
        current.section ||= section;
      }
      continue;
    }

    const sectionMatch = line.match(SECTION);
    if (sectionMatch && !line.startsWith("###")) {
      section = sectionMatch[1];
      if (/^(Baseline Policies|Assumptions|Key Terminology|Implementation|Resources|Prerequisites)$/i.test(section)) {
        section = "";
      }
      if (current) finishStatement(current);
      current = null;
      instructionsFor = null;
      continue;
    }

    if (instructionsFor) {
      if (line.startsWith("### ")) { instructionsFor = null; continue; }
      policies[instructionsFor].implementation += line + "\n";
      continue;
    }

    if (!current) continue;
    const rationale = line.match(/^-\s+_Rationale:_\s*(.*)$/);
    if (rationale) { current.rationale = rationale[1].trim(); continue; }
    const modified = line.match(/^-\s+_Last modified:_\s*(.*)$/);
    if (modified) { current.lastModified = modified[1].trim(); continue; }
    if (line.startsWith("[![") || line.startsWith("- ") || line.startsWith("  ")) continue;
    if (line.trim() === "") continue;
    if (line.startsWith("#")) { finishStatement(current); current = null; continue; }
    current.nameLines.push(line.trim());
  }
  if (current) finishStatement(current);

  for (const entry of Object.values(policies)) {
    if (entry.nameLines) finishStatement(entry);
    entry.implementation = entry.implementation.trim();
  }
  return policies;
}

const blankPolicy = (id, product, section) => ({
  id, product, name: "", section, sectionDescription: "",
  rationale: "", criticality: "", lastModified: "", implementation: "",
  nameLines: [],
});

function buildGws() {
  const spec = upstream.scubagoggles;
  const dir = join(root, "vendor/scubagoggles", spec.paths.baselines);
  const policies = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const product = file.replace(/\.md$/, "");
    Object.assign(policies, parseGwsBaseline(readFileSync(join(dir, file), "utf8"), product));
  }
  // The Rego builds policy IDs from a prefix plus a version suffix supplied in
  // the input: `baseline_suffix` for the common case, `baseline_versions` for
  // the policies that differ. Both come from the Markdown, same as upstream.
  const bySuffix = new Map();
  for (const id of Object.keys(policies)) {
    const [, prefix, suffix] = id.match(/^(.*?)(v\d+)$/) ?? [];
    if (!prefix) continue;
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
    bySuffix.get(suffix).push(prefix);
  }
  const ranked = [...bySuffix.entries()].sort((a, b) => b[1].length - a[1].length);
  const defaultSuffix = ranked[0]?.[0] ?? "v1";
  const overrides = {};
  for (const [suffix, prefixes] of ranked.slice(1)) {
    for (const prefix of prefixes) overrides[prefix] = suffix;
  }

  return {
    suite: "gws",
    version: spec.ref,
    source: srcRef(spec),
    versioning: { defaultSuffix, overrides },
    policies,
  };
}

mkdirSync(outDir, { recursive: true });
for (const baseline of [buildM365(), buildGws()]) {
  const path = join(outDir, `${baseline.suite}.json`);
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
  const count = Object.keys(baseline.policies).length;
  const unnamed = Object.values(baseline.policies).filter((p) => !p.name).length;
  console.log(`${baseline.suite}: ${count} policies -> ${path}${unnamed ? ` (${unnamed} without a statement)` : ""}`);
}

if (!existsSync(join(root, "vendor"))) throw new Error("vendor/ is missing; run `npm run vendor` first");
