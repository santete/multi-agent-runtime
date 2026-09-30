import type { ClaimResponse } from "@mar/core";
import { describe, expect, it } from "vitest";
import { buildPrompt, contextFiles } from "../src/context.js";

const claim = (extra: Partial<ClaimResponse> = {}): ClaimResponse =>
  ({
    execution: { id: "e1", attempt: 2 },
    task: { key: "PAY-3", title: "Refund API", objective: "Implement POST /refunds" },
    project: { validation: [{ name: "test", command: "npm test" }] },
    executionToken: "t",
    ...extra,
  }) as ClaimResponse;

const rework: NonNullable<ClaimResponse["rework"]> = {
  kind: "validation",
  attempt: 1,
  reason: "validation failed: test",
  validation: {
    passed: false,
    changedFiles: [],
    steps: [{ name: "test", command: "npm test", passed: false, exitCode: 1, durationMs: 5, outputTail: "1 failing" }],
  },
};

describe("task context", () => {
  it("writes a task brief with rules and the validation that will run", () => {
    const [brief, ...rest] = contextFiles(claim());
    expect(rest).toEqual([]);
    expect(brief!.path).toBe(".orchestrator/context/TASK.md");
    expect(brief!.content).toContain("# PAY-3: Refund API");
    expect(brief!.content).toContain("Implement POST /refunds");
    expect(brief!.content).toContain("Do **not** commit, push");
    expect(brief!.content).toContain("**test**: `npm test`");
  });

  it("adds REWORK.md with the failing output on rework", () => {
    const files = contextFiles(claim({ rework }));
    expect(files.map((f) => f.path)).toEqual([".orchestrator/context/TASK.md", ".orchestrator/context/REWORK.md"]);
    expect(files[1]!.content).toContain("# Rework after attempt 1");
    expect(files[1]!.content).toContain("1 failing");
  });

  it("builds prompts for first runs, interrupted runs and reworks", () => {
    expect(buildPrompt(claim(), false)).toMatch(/^Implement POST \/refunds/);
    expect(buildPrompt(claim(), true)).toMatch(/^Your previous run on this task was interrupted/);
    const reworkPrompt = buildPrompt(claim({ rework }), true);
    expect(reworkPrompt).toMatch(/^Your previous attempt was rejected \(validation failed: test\)/);
    expect(reworkPrompt).toContain(".orchestrator/context/REWORK.md");
    expect(reworkPrompt).not.toContain("interrupted");
  });

  it("adds dependency handoffs, review feedback, merge conflicts and approval decisions", () => {
    const files = contextFiles(
      claim({
        dependencies: [
          {
            key: "PAY-1",
            title: "Refund domain",
            handoff: { summary: "Added refund()", changes: ["src/refund.js"], decisions: ["idempotent"], knownIssues: [], remainingWork: [] },
          },
        ],
        rework: { kind: "merge_conflict", attempt: 2, reason: "the branch conflicts with main", baseBranch: "main" },
        approvals: [{ tool: "Bash", summary: "Bash: curl https://x", status: "approved", comment: "ok once" }],
      }),
      { conflicts: ["src/payments.js"] },
    );
    const byName = Object.fromEntries(files.map((f) => [f.path.split("/").pop(), String(f.content)]));
    expect(Object.keys(byName)).toEqual(["TASK.md", "DEPENDENCIES.md", "REWORK.md", "APPROVALS.md"]);
    expect(byName["DEPENDENCIES.md"]).toContain("## PAY-1: Refund domain");
    expect(byName["DEPENDENCIES.md"]).toContain("- idempotent");
    expect(byName["REWORK.md"]).toContain("merged the latest `main`");
    expect(byName["REWORK.md"]).toContain("- `src/payments.js`");
    expect(byName["APPROVALS.md"]).toContain("**APPROVED**: `Bash: curl https://x` — ok once (you may run exactly this now)");

    const review = contextFiles(claim({ rework: { kind: "review", attempt: 1, reason: "rejected", comment: "Use cents" } }));
    expect(String(review[1]!.content)).toContain("> Use cents");
  });

  it("tells the agent about approval decisions in the prompt", () => {
    const prompt = buildPrompt(
      claim({ approvals: [{ tool: "Bash", summary: "Bash: curl x", status: "rejected", comment: null }] }),
      true,
    );
    expect(prompt).toMatch(/^A human has decided on the actions you were blocked from taking/);
  });
});
