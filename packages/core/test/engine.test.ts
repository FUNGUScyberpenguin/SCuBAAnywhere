import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/opa/engine.js";
import { M365_PRODUCTS, GWS_PRODUCTS, type ProductId } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const policiesDir = join(root, "web/public/policies");
const sampleExport = join(
  root,
  "vendor/scubagear/PowerShell/ScubaGear/Sample-Reports/ProviderSettingsExport.json",
);

async function readJson(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
}

async function load(suite: "m365" | "gws"): Promise<PolicyEngine> {
  const dir = join(policiesDir, suite);
  try {
    const [wasm, data] = await Promise.all([readFile(join(dir, "policy.wasm")), readJson(join(dir, "data.json"))]);
    return PolicyEngine.load(wasm, data);
  } catch (cause) {
    throw new Error(`Missing ${dir}. Run \`npm run vendor && npm run policies\` first.`, { cause });
  }
}

/**
 * Counts taken from the OPA binary evaluating CISA's own sample settings export
 * at the pinned upstream commit. They are the contract between this project and
 * ScubaGear: if the browser engine drifts from the reference implementation,
 * these move.
 */
const M365_EXPECTED: Record<string, { results: number; met: number }> = {
  aad: { results: 34, met: 15 },
  defender: { results: 19, met: 10 },
  exo: { results: 12, met: 11 },
  powerbi: { results: 8, met: 0 },
  powerplatform: { results: 10, met: 5 },
  securitysuite: { results: 19, met: 12 },
  sharepoint: { results: 8, met: 8 },
  teams: { results: 14, met: 11 },
};

describe("PolicyEngine against ScubaGear's sample export", () => {
  it.each(M365_PRODUCTS)("matches the reference result for %s", async (product) => {
    const engine = await load("m365");
    const results = engine.evaluate(product, await readJson(sampleExport));
    const expected = M365_EXPECTED[product]!;

    expect(results).toHaveLength(expected.results);
    expect(results.filter((r) => r.RequirementMet === true)).toHaveLength(expected.met);
    for (const result of results) {
      expect(result.PolicyId).toMatch(/^MS\.[A-Z]+\.\d+\.\d+v\d+$/);
      expect(typeof result.RequirementMet).toBe("boolean");
    }
  });

  it("needs no Rego built-in the runtime cannot provide", async () => {
    // The two products below are the ones that use regex.find_n and indexof_n,
    // which OPA leaves to the host. A missing shim shows up here first.
    const engine = await load("m365");
    const settings = await readJson(sampleExport);
    for (const product of ["defender", "securitysuite", "exo"] as ProductId[]) {
      expect(() => engine.evaluate(product, settings)).not.toThrow();
    }
  });
});

describe("PolicyEngine against the Google Workspace baselines", () => {
  const emptyOrg = {
    tenant_info: { topLevelOU: "Example Org" },
    policies: {},
    baseline_suffix: "v1",
    baseline_versions: {},
    successful_commands: [],
    unsuccessful_commands: [],
  };

  it.each(GWS_PRODUCTS)("evaluates %s", async (product) => {
    const engine = await load("gws");
    const results = engine.evaluate(product, emptyOrg);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.PolicyId).toMatch(/^GWS\.[A-Z]+\.\d+\.\d+v\d+$/);
    }
  });
});

describe("PolicyEngine errors", () => {
  it("names the product when an entrypoint does not exist", async () => {
    const engine = await load("m365");
    expect(() => engine.evaluate("gmail", {})).toThrow(/gmail/);
  });
});
