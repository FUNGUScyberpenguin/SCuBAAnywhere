import { PRODUCT_LABELS, actionPlan, totals, type Assessment, type AssessedPolicy } from "@scubaanywhere/core";
import { escapeHtml, plainText } from "./dom.js";

/**
 * Saving a report.
 *
 * Every export is built in the browser and handed to the operator as a download
 * they started. Nothing is posted anywhere, and the app keeps no copy once the
 * session is wiped. Where the file goes next is the operator's decision, which
 * is the point.
 */
export function download(filename: string, mimeType: string, contents: string): void {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const reportFilename = (assessment: Assessment, extension: string): string => {
  const target = assessment.target.displayName.replace(/[^\w.-]+/g, "-").slice(0, 40) || "assessment";
  return `scuba-${target}-${assessment.finishedAt.slice(0, 10)}.${extension}`;
};

export function toJson(assessment: Assessment): string {
  return JSON.stringify(assessment, null, 2) + "\n";
}

export function toCsv(assessment: Assessment): string {
  const header = ["Policy", "Product", "Verdict", "Criticality", "Requirement", "Details"];
  const rows = assessment.policies.map((policy) => [
    policy.id,
    PRODUCT_LABELS[policy.product] ?? policy.product,
    policy.verdict,
    policy.criticality,
    plainText(policy.baseline?.name ?? ""),
    stripTags(policy.details),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Prefixing a cell that starts with a formula character stops a spreadsheet
 * from executing text that came out of a tenant's configuration.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

const stripTags = (value: string) => value.replace(/<[^>]*>/g, "").trim();

/** A single self-contained HTML file: no scripts, no external requests. */
export function toHtml(assessment: Assessment): string {
  const sum = totals(assessment);
  const plan = actionPlan(assessment);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCuBA assessment: ${escapeHtml(assessment.target.displayName)}</title>
<style>
  :root { color-scheme: light dark; --pass:#1a7f37; --fail:#b3261e; --warn:#8a6100; --muted:#5b6470; }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 62rem; padding: 2rem 1rem 5rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .meta { color: var(--muted); font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }
  th, td { border-bottom: 1px solid rgba(128,128,128,.35); padding: .5rem .6rem; text-align: left; vertical-align: top; }
  th { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  .v-pass { color: var(--pass); font-weight: 600; }
  .v-fail { color: var(--fail); font-weight: 600; }
  .v-warning { color: var(--warn); font-weight: 600; }
  .v-error, .v-manual { color: var(--muted); font-weight: 600; }
  .tiles { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }
  .tile { border: 1px solid rgba(128,128,128,.35); border-radius: .5rem; padding: .75rem 1.25rem; min-width: 7rem; }
  .tile b { display: block; font-size: 1.6rem; }
  details { margin: .4rem 0; }
  pre { background: rgba(128,128,128,.12); border-radius: .4rem; overflow-x: auto; padding: .75rem; font-size: .85rem; }
</style>
<h1>SCuBA assessment: ${escapeHtml(assessment.target.displayName)}</h1>
<p class="meta">
  ${escapeHtml(assessment.suite === "m365" ? "Microsoft 365" : "Google Workspace")} baselines
  ${escapeHtml(assessment.baselineVersion)} &middot; upstream ${escapeHtml(assessment.upstreamCommit.slice(0, 8))}
  &middot; assessed ${escapeHtml(assessment.finishedAt)} &middot; SCuBAAnywhere ${escapeHtml(assessment.toolVersion)}
</p>
<div class="tiles">
  ${tile("Passed", sum.pass)}${tile("Failed", sum.fail)}${tile("Warnings", sum.warning)}
  ${tile("Manual", sum.manual)}${tile("Not evaluated", sum.error)}
</div>

<h2>Action plan</h2>
${plan.length === 0 ? "<p>No failed policies.</p>" : policyTable(plan)}

<h2>All policies</h2>
${policyTable(assessment.policies)}

<h2>What this report is</h2>
<p>
  CISA's SCuBA baselines, evaluated by CISA's own Rego policies compiled to WebAssembly and run in a browser.
  It describes the configuration at the moment it was collected and nothing since.
</p>
`;
}

const tile = (label: string, value: number) => `<div class="tile"><b>${value}</b>${escapeHtml(label)}</div>`;

function policyTable(policies: AssessedPolicy[]): string {
  const rows = policies
    .map(
      (policy) => `<tr>
  <td><code>${escapeHtml(policy.id)}</code></td>
  <td class="v-${escapeHtml(policy.verdict)}">${escapeHtml(policy.verdict)}</td>
  <td>${escapeHtml(policy.criticality)}</td>
  <td>
    ${escapeHtml(plainText(policy.baseline?.name ?? ""))}
    <div class="meta">${escapeHtml(stripTags(policy.details))}</div>
    ${remediation(policy)}
  </td>
</tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Policy</th><th>Result</th><th>Criticality</th><th>Requirement</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function remediation(policy: AssessedPolicy): string {
  if (policy.verdict === "pass" || !policy.baseline?.implementation) return "";
  return `<details><summary>How to fix</summary><pre>${escapeHtml(policy.baseline.implementation)}</pre></details>`;
}
