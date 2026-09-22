import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolicyReducer } from "../src/collectors/google/policy-api.js";
import type { PolicyTables } from "../src/collectors/google/tables.js";
import type { GroupMap, OrgUnitMap, RawPolicy, ReducedPolicies } from "../src/collectors/google/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = join(root, "vendor/scubagoggles/scubagoggles/Testing/Unit/Python/data");
const tablesPath = join(root, "web/public/gws/tables.json");

/**
 * These are ScubaGoggles' own unit-test fixtures, run against this port.
 *
 * Each file holds the raw Policy API pages Google returned, the org unit and
 * group maps in effect, the defaults to apply, and the reduced result upstream
 * produces. Passing them means this reduction agrees with the reference
 * implementation on the cases upstream chose to pin down, which is the only
 * evidence worth having: a reduction that is merely self-consistent would
 * produce confident wrong verdicts.
 */
interface Fixture {
  comment: string;
  orgunits: OrgUnitMap;
  groups?: GroupMap;
  defaults: Record<string, Record<string, unknown>>;
  /** Services whose `_service_status` sections the fixture expects. */
  service_status?: string[];
  response?: { policies?: RawPolicy[] };
  responses?: Array<{ policies?: RawPolicy[] }>;
  results: ReducedPolicies;
}

function loadTables(): PolicyTables {
  try {
    return JSON.parse(readFileSync(tablesPath, "utf8")) as PolicyTables;
  } catch (cause) {
    throw new Error(`Missing ${tablesPath}. Run \`npm run vendor && npm run gws-tables\` first.`, { cause });
  }
}

const fixtures = (() => {
  try {
    return readdirSync(fixtureDir)
      .filter((name) => /^policyapi_get_policies\d+\.json$/.test(name))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch (cause) {
    throw new Error(`Missing ${fixtureDir}. Run \`npm run vendor\` first.`, { cause });
  }
})();

function policiesOf(fixture: Fixture): RawPolicy[] {
  const pages = fixture.responses ?? (fixture.response ? [fixture.response] : []);
  return pages.flatMap((page) => page.policies ?? []);
}

/**
 * Upstream's test harness swaps the real service-status sections for the ones
 * the fixture names, so a service Google adds later does not break old
 * fixtures. The same swap is applied here.
 */
function tablesFor(fixture: Fixture, tables: PolicyTables): PolicyTables {
  const sections = Object.fromEntries(
    Object.entries(tables.sections).filter(([name]) => !name.endsWith("_service_status")),
  );
  for (const service of fixture.service_status ?? []) {
    sections[`${service}_service_status`] = { settings: ["serviceState"] };
  }
  return { ...tables, sections, defaults: fixture.defaults };
}

describe("PolicyReducer against ScubaGoggles' fixtures", () => {
  const tables = loadTables();

  it("finds the upstream fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures)("reproduces %s", (name) => {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Fixture;
    const reducer = new PolicyReducer(
      tablesFor(fixture, tables),
      "topOU",
      fixture.orgunits,
      fixture.groups ?? {},
    );

    expect(reducer.reduce(policiesOf(fixture))).toEqual(fixture.results);
  });
});
