import type { SystemRule } from "../tables.js";
import type { ReducedPolicies } from "../types.js";
import type { PolicyParser } from "./parser.js";

/**
 * Completes the system-defined alert rules.
 *
 * Google's Policy API returns only the rules an administrator has changed, and
 * mixes user-defined rules in with them. The baseline asks whether each
 * system-defined rule is on, so the Rego needs the full set: user-defined rules
 * are dropped, and every unchanged system rule is added back in the state
 * Google ships it in.
 */
export class SystemRulesParser implements PolicyParser {
  private readonly known: Map<string, SystemRule>;

  constructor(
    private readonly policies: ReducedPolicies,
    systemRules: SystemRule[],
  ) {
    this.known = new Map(systemRules.map((rule) => [rule.displayName, rule]));
  }

  parse(orgUnit: string, section: string): void {
    const orgPolicies = this.policies[orgUnit];
    if (!orgPolicies) return;

    const existing = orgPolicies[section];
    const rules = Array.isArray(existing) ? (existing as Array<Record<string, unknown>>) : [];
    if (!Array.isArray(existing)) orgPolicies[section] = rules;

    // Last index wins for a repeated display name, matching upstream.
    const found = new Map<string, number>();
    rules.forEach((rule, index) => found.set(String(rule["displayName"] ?? ""), index));

    const userDefined = [...found.entries()]
      .filter(([name]) => !this.known.has(name))
      .map(([, index]) => index)
      .sort((a, b) => b - a);
    for (const index of userDefined) rules.splice(index, 1);

    for (const state of ["ACTIVE", "INACTIVE"] as const) {
      for (const rule of this.known.values()) {
        if (rule.state !== state || found.has(rule.displayName)) continue;
        rules.push({ displayName: rule.displayName, description: rule.description, state });
      }
    }
  }
}
