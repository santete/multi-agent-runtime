import { describe, expect, it } from "vitest";
import { alignChecks, checkPlan, enforceCriteria, type ReviewResult, toContract, toHandoff, toReviewResult } from "../src/index.js";

describe("collaboration contract (spec §62)", () => {
  it("normalizes a contract", () => {
    expect(toContract({ inputs: [" docs/a.md ", 3], constraints: [], expectedOutput: " An endpoint ", acceptanceCriteria: ["A", "A", " ", "B"] })).toEqual({
      inputs: ["docs/a.md"],
      constraints: [],
      expectedOutput: "An endpoint",
      acceptanceCriteria: ["A", "B"],
    });
    expect(toContract({})).toEqual({ inputs: [], constraints: [], expectedOutput: "", acceptanceCriteria: [] });
  });

  it("aligns reported checks with the task's criteria: by text, by position, unreported is not met", () => {
    const criteria = ["Refunds are idempotent", "README documents refunds"];
    expect(alignChecks(criteria, [{ criterion: "readme documents refunds.", met: true, evidence: "README.md" }])).toEqual([
      { criterion: "Refunds are idempotent", met: false, evidence: "not reported" },
      { criterion: "README documents refunds", met: true, evidence: "README.md" },
    ]);
    // Reworded, but one report per criterion: taken in order.
    expect(
      alignChecks(criteria, [
        { criterion: "Idempotent refunds", met: true, evidence: "t1" },
        { criterion: "Docs", met: true, evidence: "t2" },
      ]).map((c) => c.met),
    ).toEqual([true, true]);
    expect(alignChecks(criteria, "garbage").every((c) => !c.met)).toBe(true);
  });

  it("reads criteria from handoffs and reviews", () => {
    expect(toHandoff({ summary: "s", criteria: [{ criterion: "A", met: true, evidence: "e" }, { met: true }] }).criteria).toEqual([{ criterion: "A", met: true, evidence: "e" }]);
    expect(toReviewResult({ verdict: "approve", summary: "", findings: [] })?.criteria).toEqual([]);
  });

  it("turns an approval that leaves a criterion unmet or unchecked into a request for changes (spec §63)", () => {
    const review = (criteria: ReviewResult["criteria"]): ReviewResult => ({ verdict: "approve", summary: "looks good", findings: [], criteria });
    const criteria = ["A", "B"];
    const overridden = enforceCriteria(review([{ criterion: "A", met: true, evidence: "test" }]), criteria);
    expect(overridden.verdict).toBe("request_changes");
    expect(overridden.findings).toEqual([{ severity: "blocker", file: "", line: null, message: "Acceptance criterion not met: B (not reported)" }]);
    expect(overridden.summary).toContain("Approval overridden by the platform");

    const ok = enforceCriteria(review([{ criterion: "A", met: true, evidence: "t" }, { criterion: "B", met: true, evidence: "t" }]), criteria);
    expect(ok.verdict).toBe("approve");
    expect(enforceCriteria(review([]), []).verdict).toBe("approve");
  });

  it("plans carry a contract per task", () => {
    const check = checkPlan({
      tasks: [{ ref: "T1", title: "t", objective: "o", agent: null, acceptanceCriteria: ["Works"], expectedOutput: "x", constraints: ["c"], inputs: [] }],
    });
    expect(check.ok && check.plan.tasks[0]).toMatchObject({ acceptanceCriteria: ["Works"], expectedOutput: "x", constraints: ["c"], inputs: [] });
  });
});
