/**
 * The tables that drive Google Workspace policy reduction.
 *
 * These are extracted from ScubaGoggles' own source at the pinned commit by
 * tools/build-gws-tables.mjs, not transcribed. They decide which settings are
 * read, how duplicate policies for one org unit are reduced, and what Google's
 * documented defaults are, so a hand copy that drifts would quietly change
 * every Google assessment.
 */

/** How several policies for the same org unit and section become one. */
export type ReducerName = "merge" | "maxMap" | "list";

/** Sections that need reshaping before the Rego can read them. */
export type ParserName = "gmailRules" | "dlpRules" | "systemRules";

export interface PolicySection {
  /** Setting names Google returns for this section. */
  settings: string[];
  /** Absent means the default reduction: the policy with the highest sort order wins. */
  reducer?: ReducerName;
  /** Primary key for a maxMap reduction. Defaults to `ruleId`. */
  key?: string;
  parser?: ParserName;
}

export interface SystemRule {
  displayName: string;
  description: string;
  state: "ACTIVE" | "INACTIVE";
}

export interface PolicyTables {
  source: { repo: string; ref: string; commit: string };
  sections: Record<string, PolicySection>;
  defaults: Record<string, Record<string, unknown>>;
  /** Every system-defined alert rule, with the state Google ships it in. */
  systemRules: SystemRule[];
}
