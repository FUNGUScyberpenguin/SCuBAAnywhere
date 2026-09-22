import { PRODUCT_LABELS, actionPlan, totals, type AssessedPolicy, type Assessment } from "@scubaanywhere/core";
import { clear, el } from "./dom.js";
import { download, reportFilename, toCsv, toHtml, toJson } from "./export.js";

const VERDICT_LABELS: Record<AssessedPolicy["verdict"], string> = {
  pass: "Pass",
  fail: "Fail",
  warning: "Warning",
  error: "Not evaluated",
  manual: "Manual check",
};

export function renderReport(container: HTMLElement, assessment: Assessment): void {
  clear(container);
  const sum = totals(assessment);

  container.append(
    el("h2", {}, `Assessment: ${assessment.target.displayName}`),
    el(
      "p",
      { class: "meta" },
      `${assessment.suite === "m365" ? "Microsoft 365" : "Google Workspace"} baselines ` +
        `${assessment.baselineVersion} · upstream ${assessment.upstreamCommit.slice(0, 8)} · ` +
        `assessed ${new Date(assessment.finishedAt).toLocaleString()}`,
    ),
    el(
      "div",
      { class: "tiles" },
      tile("Passed", sum.pass, "pass"),
      tile("Failed", sum.fail, "fail"),
      tile("Warnings", sum.warning, "warning"),
      tile("Manual checks", sum.manual, "manual"),
      tile("Not evaluated", sum.error, "error"),
    ),
    exportBar(assessment),
    el("h3", {}, "By product"),
    productTable(assessment),
    el("h3", {}, "Action plan"),
    assessment.policies.length === 0
      ? el("p", {}, "No policies were evaluated.")
      : policyList(actionPlan(assessment), "Nothing failed."),
    el("h3", {}, "All policies"),
    policyList(assessment.policies, "No results."),
  );
}

const tile = (label: string, value: number, verdict: string) =>
  el("div", { class: `tile v-${verdict}` }, el("b", {}, String(value)), el("span", {}, label));

function exportBar(assessment: Assessment): HTMLElement {
  const save = (extension: string, mime: string, contents: string) => () =>
    download(reportFilename(assessment, extension), mime, contents);

  return el(
    "div",
    { class: "export-bar" },
    el("span", { class: "meta" }, "Save a copy. The file is written here in the browser and uploaded nowhere."),
    el("button", { type: "button", onclick: save("html", "text/html", toHtml(assessment)) }, "HTML report"),
    el("button", { type: "button", onclick: save("json", "application/json", toJson(assessment)) }, "JSON"),
    el("button", { type: "button", onclick: save("csv", "text/csv", toCsv(assessment)) }, "CSV"),
  );
}

function productTable(assessment: Assessment): HTMLElement {
  const head = el(
    "tr",
    {},
    ...["Product", "Pass", "Fail", "Warning", "Manual", "Not evaluated"].map((label) => el("th", {}, label)),
  );
  const rows = assessment.products.map((product) =>
    el(
      "tr",
      {},
      el("td", {}, PRODUCT_LABELS[product.product] ?? product.product),
      el("td", {}, String(product.pass)),
      el("td", {}, String(product.fail)),
      el("td", {}, String(product.warning)),
      el("td", {}, String(product.manual)),
      el(
        "td",
        {},
        String(product.error),
        product.failedCollectors.length > 0
          ? el("div", { class: "meta" }, `Missing: ${product.failedCollectors.join(", ")}`)
          : null,
      ),
    ),
  );
  return el("table", { class: "product-table" }, el("thead", {}, head), el("tbody", {}, ...rows));
}

function policyList(policies: AssessedPolicy[], emptyMessage: string): HTMLElement {
  if (policies.length === 0) return el("p", {}, emptyMessage);
  return el("div", { class: "policies" }, ...policies.map(policyRow));
}

function policyRow(policy: AssessedPolicy): HTMLElement {
  const summary = el(
    "summary",
    {},
    el("span", { class: `verdict v-${policy.verdict}` }, VERDICT_LABELS[policy.verdict]),
    el("code", {}, policy.id),
    el("span", { class: "policy-name" }, policy.baseline?.name ?? ""),
  );

  const body = el("div", { class: "policy-body" });
  // ScubaGear puts small anchors and <br/> in ReportDetails; render it as text.
  body.append(el("p", {}, policy.details.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()));

  if (policy.baseline?.rationale) {
    body.append(el("h4", {}, "Why"), el("p", {}, policy.baseline.rationale));
  }
  if (policy.verdict !== "pass" && policy.baseline?.implementation) {
    body.append(el("h4", {}, "How to fix"), el("pre", {}, policy.baseline.implementation));
  }
  if (policy.missingCollectors?.length) {
    body.append(
      el("h4", {}, "Why this was not evaluated"),
      el("p", {}, `No data from ${policy.missingCollectors.join(", ")}.`),
    );
  }
  if (policy.actualValue !== undefined) {
    body.append(
      el(
        "details",
        { class: "actual" },
        el("summary", {}, "What was found"),
        el("pre", {}, JSON.stringify(policy.actualValue, null, 2)),
      ),
    );
  }

  return el("details", { class: `policy v-${policy.verdict}` }, summary, body);
}
