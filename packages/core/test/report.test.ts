import { describe, expect, it } from "vitest";
import { actionPlan, assembleAssessment, classify, totals } from "../src/report.js";
import type { BaselineDocument, PolicyResult } from "../src/types.js";

const baseline: BaselineDocument = {
  suite: "m365",
  version: "test",
  source: { repo: "", ref: "", commit: "" },
  policies: {
    "MS.AAD.1.1v1": {
      id: "MS.AAD.1.1v1", product: "aad", name: "Legacy authentication SHALL be blocked.",
      section: "Legacy Authentication", sectionDescription: "", rationale: "",
      criticality: "SHALL", lastModified: "", implementation: "Create a conditional access policy.",
    },
  },
};

const result = (over: Partial<PolicyResult>): PolicyResult => ({
  PolicyId: "MS.AAD.1.1v1",
  RequirementMet: false,
  Criticality: "Shall",
  ReportDetails: "Requirement not met",
  ...over,
});

describe("classify", () => {
  it("passes a met requirement", () => {
    expect(classify(result({ RequirementMet: true }), [])).toBe("pass");
  });

  it("reports a failed SHOULD as a warning", () => {
    expect(classify(result({ Criticality: "Should" }), [])).toBe("warning");
  });

  it("reports policies the tooling cannot check as manual", () => {
    expect(classify(result({ Criticality: "Shall/Not-Implemented" }), [])).toBe("manual");
    expect(classify(result({ Criticality: "Should/3rd Party" }), [])).toBe("manual");
  });

  it("fails a failed SHALL", () => {
    expect(classify(result({}), [])).toBe("fail");
  });

  it("marks a policy unevaluated when a collector it needs did not run", () => {
    // This is the behaviour that keeps a partial collection honest: a missing
    // collector must never read as a pass.
    expect(classify(result({ RequirementMet: true }), ["Get-MgBetaDomain"])).toBe("error");
  });
});

describe("assembleAssessment", () => {
  const assemble = (results: PolicyResult[], failedCollectors: string[] = []) =>
    assembleAssessment({
      suite: "m365",
      target: { id: "tenant-id", displayName: "Contoso" },
      startedAt: "2026-01-01T00:00:00.000Z",
      toolVersion: "0.1.0",
      baseline,
      upstreamCommit: "abc1234",
      evaluations: [{ product: "aad", results, failedCollectors }],
      now: new Date("2026-01-01T00:05:00.000Z"),
    });

  it("joins the verdict to the baseline text", () => {
    const assessment = assemble([result({})]);
    expect(assessment.policies[0]?.baseline?.name).toBe("Legacy authentication SHALL be blocked.");
    expect(assessment.policies[0]?.verdict).toBe("fail");
  });

  it("only marks a policy unevaluated when its own collector failed", () => {
    const assessment = assemble(
      [
        result({ PolicyId: "MS.AAD.1.1v1", Commandlet: ["Get-MgBetaDomain"] }),
        result({ PolicyId: "MS.AAD.2.1v1", Commandlet: ["Get-MgBetaUser"], RequirementMet: true }),
      ],
      ["Get-MgBetaDomain"],
    );
    const byId = Object.fromEntries(assessment.policies.map((p) => [p.id, p]));
    expect(byId["MS.AAD.1.1v1"]?.verdict).toBe("error");
    expect(byId["MS.AAD.1.1v1"]?.missingCollectors).toEqual(["Get-MgBetaDomain"]);
    expect(byId["MS.AAD.2.1v1"]?.verdict).toBe("pass");
  });

  it("counts verdicts per product", () => {
    const assessment = assemble([
      result({ PolicyId: "MS.AAD.1.1v1", RequirementMet: true }),
      result({ PolicyId: "MS.AAD.2.1v1" }),
      result({ PolicyId: "MS.AAD.3.1v1", Criticality: "Should" }),
    ]);
    expect(totals(assessment)).toEqual({ pass: 1, fail: 1, warning: 1, error: 0, manual: 0 });
  });

  it("puts failed SHALLs ahead of failed SHOULDs in the action plan", () => {
    const assessment = assemble([
      result({ PolicyId: "MS.AAD.3.1v1", Criticality: "Should" }),
      result({ PolicyId: "MS.AAD.2.1v1" }),
      result({ PolicyId: "MS.AAD.1.1v1", RequirementMet: true }),
    ]);
    expect(actionPlan(assessment).map((p) => p.id)).toEqual(["MS.AAD.2.1v1", "MS.AAD.3.1v1"]);
  });
});
