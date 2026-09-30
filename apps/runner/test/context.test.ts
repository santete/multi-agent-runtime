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

const rework = {
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
    expect(reworkPrompt).toMatch(/^Your previous attempt failed \(validation failed: test\)/);
    expect(reworkPrompt).toContain(".orchestrator/context/REWORK.md");
    expect(reworkPrompt).not.toContain("interrupted");
  });
});
