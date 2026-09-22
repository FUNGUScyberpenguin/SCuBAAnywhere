#!/usr/bin/env node
// Extract the Google Workspace policy tables from ScubaGoggles' source.
//
// ScubaGoggles' Policy API layer is driven by three tables that live as Python
// literals: which policy sections matter and how each is reduced, Google's
// documented default values, and the full set of system-defined alert rules.
// The browser collector needs the same tables, so they are read out of the
// pinned source rather than transcribed by hand.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PyName, readAssignment } from "./lib/python-literal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const goggles = join(root, "vendor/scubagoggles/scubagoggles");

const REDUCERS = { _list_reducer: "list", _merge_reducer: "merge", _max_map_reducer: "maxMap" };
const PARSERS = { GmailRulesParser: "gmailRules", DlpRulesParser: "dlpRules", SystemRulesParser: "systemRules" };

function buildSections(source) {
  const raw = readAssignment(source, "_expectedPolicySettings");
  const sections = {};

  for (const [name, entry] of Object.entries(raw)) {
    const section = {};
    for (const [field, value] of Object.entries(entry)) {
      switch (field) {
        case "settings":
          // Only the setting names are needed; the values are validators.
          section.settings = Object.keys(value);
          break;
        case "reducer": {
          const reducer = REDUCERS[nameOf(value)];
          if (!reducer) throw new Error(`${name}: unknown reducer ${nameOf(value)}`);
          section.reducer = reducer;
          break;
        }
        case "key":
          section.key = value;
          break;
        case "parser": {
          const parser = PARSERS[nameOf(value)];
          if (!parser) throw new Error(`${name}: unknown parser ${nameOf(value)}`);
          section.parser = parser;
          break;
        }
        default:
          throw new Error(`${name}: unexpected field "${field}" in the expected settings table`);
      }
    }
    if (!section.settings) throw new Error(`${name}: no settings listed`);
    sections[name] = section;
  }
  return sections;
}

const nameOf = (value) => (value instanceof PyName ? value.name : String(value));

function buildDefaults(source) {
  // _defaults is assigned once and then extended with _defaults.update({...}).
  return { ...readAssignment(source, "_defaults"), ...readAssignment(source, "_defaults", { update: true }) };
}

function buildSystemRules(source) {
  const active = readAssignment(source, "ACTIVE_RULE_DEFAULTS");
  const inactive = readAssignment(source, "INACTIVE_RULE_DEFAULTS");
  const rules = [];
  for (const [state, group] of [["ACTIVE", active], ["INACTIVE", inactive]]) {
    for (const [displayName, description] of Object.entries(group)) {
      rules.push({ displayName, description, state });
    }
  }
  return rules;
}

const policyApi = readFileSync(join(goggles, "policy_api.py"), "utf8");
const systemRulesParser = readFileSync(join(goggles, "parsers/system_rules_parser.py"), "utf8");

const tables = {
  source: {
    repo: upstream.scubagoggles.repo,
    ref: upstream.scubagoggles.ref,
    commit: upstream.scubagoggles.commit,
  },
  sections: buildSections(policyApi),
  defaults: buildDefaults(policyApi),
  systemRules: buildSystemRules(systemRulesParser),
};

// Guard rails. These numbers are not magic constants to keep in step by hand:
// they are lower bounds that catch a parse which silently produced a fraction
// of the table, which would quietly change what every Google assessment says.
const sectionCount = Object.keys(tables.sections).length;
const defaultCount = Object.keys(tables.defaults).length;
if (sectionCount < 50) throw new Error(`only ${sectionCount} policy sections parsed; the table should have far more`);
if (defaultCount < 15) throw new Error(`only ${defaultCount} defaults parsed; the table should have far more`);
if (tables.systemRules.length < 20) throw new Error(`only ${tables.systemRules.length} system rules parsed`);
for (const [name, section] of Object.entries(tables.sections)) {
  if (section.reducer === "maxMap" && section.settings.length !== 1) {
    throw new Error(`${name}: a maxMap section must have exactly one setting, found ${section.settings.length}`);
  }
}

const outPath = join(root, "web/public/gws/tables.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(tables, null, 2) + "\n");

const reducers = Object.values(tables.sections).reduce((counts, s) => {
  const key = s.reducer ?? "sortOrder";
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
console.log(
  `gws tables: ${sectionCount} sections (${Object.entries(reducers).map(([k, v]) => `${v} ${k}`).join(", ")}), ` +
    `${defaultCount} defaults, ${tables.systemRules.length} system rules -> ${outPath}`,
);
