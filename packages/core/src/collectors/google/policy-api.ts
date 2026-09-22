import type { PolicySection, PolicyTables } from "./tables.js";
import type { GroupMap, OrgUnitMap, OrgUnitPolicies, RawPolicy, ReducedPolicies } from "./types.js";
import { DlpRulesParser } from "./parsers/dlp-rules.js";
import { GmailRulesParser } from "./parsers/gmail-rules.js";
import { SystemRulesParser } from "./parsers/system-rules.js";
import type { PolicyParser } from "./parsers/parser.js";

/**
 * Turns Google's raw policy list into the `input.policies` map the Rego reads.
 *
 * Google returns one entry per setting per policy target, and several entries
 * can apply to the same org unit. Reducing them is not incidental: 135 of the
 * ~170 `input.<key>` references across ScubaGoggles' baselines read
 * `input.policies`, so a setting reduced the wrong way produces a confident
 * wrong verdict rather than an unevaluated policy.
 *
 * This follows ScubaGoggles' PolicyAPI step for step. See
 * https://cloud.google.com/identity/docs/concepts/policy-api-concepts
 * for Google's own description of the reduction.
 */
export class PolicyReducer {
  private readonly reduction = new Map<string, RawPolicy | RawPolicy[]>();

  constructor(
    private readonly tables: PolicyTables,
    private readonly topOrgUnit: string,
    private readonly orgUnits: OrgUnitMap,
    private readonly groups: GroupMap,
  ) {}

  reduce(policies: RawPolicy[]): ReducedPolicies {
    this.reduction.clear();
    this.collect(policies);

    const result: ReducedPolicies = {};
    for (const [key, policy] of this.reduction) {
      const { orgUnit, section } = splitKey(key);
      (result[orgUnit] ??= {})[section] = settingsOf(policy);
    }

    this.applyDefaults(result);
    this.runParsers(result);
    return result;
  }

  /**
   * Sorting by highest sort order first is what makes the default reduction
   * work, and the merge and maxMap reducers depend on it too.
   *
   * The sort must be stable: Python's `sort(reverse=True)` keeps the original
   * order of entries with equal sort order rather than reversing them, and
   * comparing numerically here does the same.
   */
  private collect(policies: RawPolicy[]): void {
    const ordered = [...policies].sort((a, b) => b.policyQuery.sortOrder - a.policyQuery.sortOrder);

    for (const policy of ordered) {
      const orgUnit = this.targetName(policy);
      if (orgUnit === null) continue;

      const section = sectionName(policy.setting.type);
      const key = makeKey(orgUnit, section);
      const expected: PolicySection | undefined = this.tables.sections[section];
      const reducer = expected?.reducer;

      const current = this.reduction.get(key);
      if (current === undefined) {
        this.reduction.set(key, reducer === "list" ? [policy] : policy);
        continue;
      }
      // A section outside the baselines needs no reduction; the highest sort
      // order already won.
      if (!expected) continue;

      if (reducer === "list") this.listReduce(key, policy);
      else if (reducer === "merge") this.mergeReduce(key, policy);
      else if (reducer === "maxMap") this.maxMapReduce(key, policy, expected);
    }
  }

  /**
   * The org unit or group a policy applies to, named the way the Rego expects.
   * Returns null for a policy targeting an org unit that no longer exists,
   * which Google can still return for a recently deleted one.
   */
  private targetName(policy: RawPolicy): string | null {
    let name: string;

    const orgUnitRef = policy.policyQuery.orgUnit;
    if (orgUnitRef) {
      const id = orgUnitRef.replace(/^orgUnits\//, "");
      const info = this.orgUnits[id];
      if (!info) return null;

      name = info.name;
      const path = info.path;
      // A sub-org unit's name is not unique on its own, so the parent path is
      // appended when the org unit sits below the first level.
      if (path.length > 1 && name !== path.slice(1)) {
        const parent = path.slice(1).replace(new RegExp(`/${escapeRegExp(name)}$`), "");
        name += ` (in ${parent})`;
      }
    } else {
      // Rare, but Google does return policies with no org unit. They apply to
      // the top-level org unit.
      name = this.topOrgUnit;
    }

    const groupRef = policy.policyQuery.group;
    if (groupRef) {
      const id = groupRef.replace(/^groups\//, "");
      // Google sometimes returns a name here instead of `groups/<id>`, in which
      // case it is used as-is.
      name += ` (group ${this.groups[id] ?? id})`;
    }
    return name;
  }

  private listReduce(key: string, policy: RawPolicy): void {
    const current = this.reduction.get(key);
    const list = Array.isArray(current) ? current : [current as RawPolicy];
    list.push(policy);
    this.reduction.set(key, list);
  }

  /** Fill in settings the in-effect policy does not carry. */
  private mergeReduce(key: string, policy: RawPolicy): void {
    const current = settingsOf(this.reduction.get(key)!) as Record<string, unknown>;
    for (const [setting, value] of Object.entries(policy.setting.value)) {
      if (!(setting in current)) current[setting] = value;
    }
  }

  /**
   * For a section whose one setting is a list of keyed entries, add entries the
   * in-effect policy is missing and fill in fields missing from the ones it has.
   */
  private maxMapReduce(key: string, policy: RawPolicy, expected: PolicySection): void {
    const primaryKey = expected.key ?? "ruleId";
    const settingName = expected.settings[0];
    if (!settingName) return;

    const current = settingsOf(this.reduction.get(key)!) as Record<string, unknown>;
    const currentEntries = current[settingName];
    const given = (policy.setting.value[settingName] ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(currentEntries)) return;

    const entries = currentEntries as Array<Record<string, unknown>>;
    const byKey = new Map<unknown, Record<string, unknown>>(entries.map((e) => [e[primaryKey], e]));

    for (const entry of given) {
      const existing = byKey.get(entry[primaryKey]);
      if (existing) {
        for (const [field, value] of Object.entries(entry)) {
          if (!(field in existing)) existing[field] = value;
        }
      } else {
        entries.push(entry);
        byKey.set(entry[primaryKey], entry);
      }
    }
  }

  /**
   * Google omits settings that are at their default, and omits a service's
   * status entirely when the tenant has no SKU for it. The top-level org unit
   * has to carry every setting, because sub-org units only record differences.
   */
  private applyDefaults(policies: ReducedPolicies): void {
    const top = (policies[this.topOrgUnit] ??= {});

    // A missing service status means the customer does not subscribe to the
    // service, which Google says to read as disabled.
    const missingStatus = Object.keys(this.tables.sections)
      .filter((section) => section.endsWith("_service_status") && !(section in top))
      .sort();
    for (const section of missingStatus) top[section] = { serviceState: "DISABLED" };

    for (const [section, settings] of Object.entries(this.tables.defaults)) {
      const existing = top[section];
      if (existing === undefined) {
        top[section] = { ...settings };
        continue;
      }
      const target = existing as Record<string, unknown>;
      for (const [setting, value] of Object.entries(settings)) {
        if (!(setting in target)) target[setting] = value;
      }
    }
  }

  /**
   * Some sections need reshaping that would be painful in Rego. Each parser is
   * built once and shared, and the top org unit is always parsed so a parser
   * can supply defaults where Google returned nothing.
   */
  private runParsers(policies: ReducedPolicies): void {
    const byName = new Map<string, PolicyParser>();
    const forSection = new Map<string, PolicyParser>();

    for (const [section, spec] of Object.entries(this.tables.sections)) {
      if (!spec.parser) continue;
      let parser = byName.get(spec.parser);
      if (!parser) {
        parser = this.makeParser(spec.parser, policies);
        byName.set(spec.parser, parser);
      }
      forSection.set(section, parser);
    }
    if (forSection.size === 0) return;

    const orgUnits = [this.topOrgUnit, ...Object.keys(policies).filter((ou) => ou !== this.topOrgUnit)];
    for (const orgUnit of orgUnits) {
      const orgPolicies: OrgUnitPolicies | undefined = policies[orgUnit];
      if (!orgPolicies) continue;
      for (const [section, parser] of forSection) {
        if (section in orgPolicies || orgUnit === this.topOrgUnit) parser.parse(orgUnit, section);
      }
    }
  }

  private makeParser(name: string, policies: ReducedPolicies): PolicyParser {
    switch (name) {
      case "gmailRules":
        return new GmailRulesParser(policies, this.topOrgUnit);
      case "dlpRules":
        return new DlpRulesParser(policies);
      case "systemRules":
        return new SystemRulesParser(policies, this.tables.systemRules);
      default:
        throw new Error(`Unknown Google policy parser "${name}" in the generated tables.`);
    }
  }
}

/** `settings/rule.dlp` becomes `rule_dlp`, because Rego reads dots as hierarchy. */
export function sectionName(settingType: string): string {
  return settingType.replace(/^settings\//, "").replaceAll(".", "_");
}

/** A list-reduced section yields every policy's value; every other yields one. */
function settingsOf(policy: RawPolicy | RawPolicy[]): unknown {
  return Array.isArray(policy) ? policy.map((p) => p.setting.value) : policy.setting.value;
}

// The reduction is keyed by (org unit, section). A unit separator keeps an org
// unit name containing the delimiter from colliding with another key.
const SEPARATOR = "\u001f";
const makeKey = (orgUnit: string, section: string) => `${orgUnit}${SEPARATOR}${section}`;

function splitKey(key: string): { orgUnit: string; section: string } {
  const index = key.lastIndexOf(SEPARATOR);
  return { orgUnit: key.slice(0, index), section: key.slice(index + 1) };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
