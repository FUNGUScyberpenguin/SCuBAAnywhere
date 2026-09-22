/** Shared shapes for an assessment run. Nothing here is ever persisted. */

/** Which set of CISA baselines a run is evaluating. */
export type SuiteId = "m365" | "gws";

export const M365_PRODUCTS = [
  "aad", "defender", "exo", "powerbi", "powerplatform", "securitysuite", "sharepoint", "teams",
] as const;

export const GWS_PRODUCTS = [
  "assuredcontrols", "calendar", "chat", "classroom", "commoncontrols",
  "drive", "gemini", "gmail", "groups", "meet", "sites",
] as const;

export type M365Product = (typeof M365_PRODUCTS)[number];
export type GwsProduct = (typeof GWS_PRODUCTS)[number];
export type ProductId = M365Product | GwsProduct;

/**
 * The document the Rego policies read. ScubaGear calls this the provider
 * settings export; ScubaGoggles calls it the settings export. Both are a flat
 * bag of collected configuration, so it stays loosely typed on purpose.
 */
export type ProviderExport = Record<string, unknown>;

/** One policy verdict, exactly as the Rego emits it. */
export interface PolicyResult {
  PolicyId: string;
  RequirementMet: boolean;
  Criticality: string;
  ReportDetails: string;
  ActualValue?: unknown;
  Commandlet?: string[];
  /** ScubaGoggles only: the check relied on admin log events and found none. */
  NoSuchEvent?: boolean;
  Prerequisites?: string[];
}

/** Baseline prose for one policy, normalised from CISA's published baselines. */
export interface BaselinePolicy {
  id: string;
  product: string;
  name: string;
  section: string;
  sectionDescription: string;
  rationale: string;
  criticality: string;
  lastModified: string;
  implementation: string;
}

export interface BaselineDocument {
  suite: SuiteId;
  version: string;
  source: { repo: string; ref: string; commit: string };
  versioning?: { defaultSuffix: string; overrides: Record<string, string> };
  policies: Record<string, BaselinePolicy>;
}

/**
 * How a single policy came out. These mirror ScubaGear's own display strings so
 * a web report and a PowerShell report can be compared line for line: `warning`
 * is a failed SHOULD, `manual` is a policy the tooling cannot check, and `error`
 * means a collector failed so the policy was never evaluated.
 */
export type Verdict = "pass" | "fail" | "warning" | "error" | "manual";

export interface AssessedPolicy {
  id: string;
  product: ProductId;
  verdict: Verdict;
  criticality: string;
  details: string;
  actualValue?: unknown;
  baseline?: BaselinePolicy;
  /** Collectors this policy needed that did not run. Only set on `error`. */
  missingCollectors?: string[];
}

export interface ProductSummary {
  product: ProductId;
  pass: number;
  fail: number;
  warning: number;
  error: number;
  manual: number;
  /** Collectors that did not run, so the policies needing them are unevaluated. */
  failedCollectors: string[];
}

/**
 * The finished assessment. It exists in a browser tab's memory and in whatever
 * file the operator chooses to save. It is never uploaded anywhere.
 */
export interface Assessment {
  suite: SuiteId;
  /** Tenant/organisation the run was pointed at, for the operator's own records. */
  target: { id: string; displayName: string; domain?: string };
  startedAt: string;
  finishedAt: string;
  toolVersion: string;
  baselineVersion: string;
  upstreamCommit: string;
  products: ProductSummary[];
  policies: AssessedPolicy[];
}

/** Minimal transport the collectors need; a browser `fetch` satisfies it. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
