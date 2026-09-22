import type {
  AssessedPolicy, Assessment, BaselineDocument, PolicyResult,
  ProductId, ProductSummary, SuiteId, Verdict,
} from "./types.js";

/**
 * Classify one Rego verdict the way ScubaGear's reporter does, so a web report
 * and a PowerShell report can be compared line for line.
 */
export function classify(result: PolicyResult, missingCollectors: string[]): Verdict {
  if (missingCollectors.length > 0) return "error";
  if (result.RequirementMet) return "pass";
  const criticality = result.Criticality ?? "";
  if (criticality.toLowerCase() === "should") return "warning";
  if (/3rd Party$|Not-Implemented$/i.test(criticality)) return "manual";
  return "fail";
}

/** Results for one product, plus the collectors that failed while gathering it. */
export interface ProductEvaluation {
  product: ProductId;
  results: PolicyResult[];
  /** Collector names that errored. ScubaGear calls these unsuccessful commands. */
  failedCollectors?: string[];
}

export interface AssembleOptions {
  suite: SuiteId;
  target: Assessment["target"];
  startedAt: string;
  toolVersion: string;
  baseline: BaselineDocument;
  upstreamCommit: string;
  evaluations: ProductEvaluation[];
  /** Defaults to `new Date()`; injectable so report output is reproducible in tests. */
  now?: Date;
}

export function assembleAssessment(options: AssembleOptions): Assessment {
  const { baseline, evaluations } = options;
  const policies: AssessedPolicy[] = [];
  const products: ProductSummary[] = [];

  for (const evaluation of evaluations) {
    const failedCollectors = evaluation.failedCollectors ?? [];
    const summary: ProductSummary = {
      product: evaluation.product,
      pass: 0, fail: 0, warning: 0, error: 0, manual: 0,
      failedCollectors,
    };

    for (const result of evaluation.results) {
      // A policy is only unevaluated if a collector *it depends on* failed.
      const missing = (result.Commandlet ?? []).filter((c) => failedCollectors.includes(c));
      const verdict = classify(result, missing);
      summary[verdict] += 1;

      const assessed: AssessedPolicy = {
        id: result.PolicyId,
        product: evaluation.product,
        verdict,
        criticality: result.Criticality ?? "",
        details: verdict === "error" ? errorDetails(missing) : result.ReportDetails ?? "",
        actualValue: result.ActualValue,
      };
      const policy = baseline.policies[result.PolicyId];
      if (policy) assessed.baseline = policy;
      if (missing.length > 0) assessed.missingCollectors = missing;
      policies.push(assessed);
    }
    products.push(summary);
  }

  policies.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  const now = options.now ?? new Date();
  return {
    suite: options.suite,
    target: options.target,
    startedAt: options.startedAt,
    finishedAt: now.toISOString(),
    toolVersion: options.toolVersion,
    baselineVersion: baseline.version,
    upstreamCommit: options.upstreamCommit,
    products,
    policies,
  };
}

const errorDetails = (missing: string[]) =>
  `Not evaluated. This policy depends on data from ${missing.join(", ")}, which did not return.`;

/** Failed SHALLs first, then failed SHOULDs: the order to work the findings in. */
export function actionPlan(assessment: Assessment): AssessedPolicy[] {
  const rank: Record<Verdict, number> = { fail: 0, warning: 1, error: 2, manual: 3, pass: 4 };
  return assessment.policies
    .filter((p) => p.verdict === "fail" || p.verdict === "warning")
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.id.localeCompare(b.id, "en", { numeric: true }));
}

export interface Totals { pass: number; fail: number; warning: number; error: number; manual: number }

export function totals(assessment: Assessment): Totals {
  const sum: Totals = { pass: 0, fail: 0, warning: 0, error: 0, manual: 0 };
  for (const product of assessment.products) {
    sum.pass += product.pass;
    sum.fail += product.fail;
    sum.warning += product.warning;
    sum.error += product.error;
    sum.manual += product.manual;
  }
  return sum;
}
