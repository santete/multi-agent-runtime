import type { TaskDto } from "@mar/core";
import { describe, expect, it } from "vitest";
import { pullRequestBody } from "../src/pull-request.js";

const task = { key: "PAY-1", title: "Refund", objective: "Add refunds", agent: "codex" } as TaskDto;

describe("pull request body", () => {
  it("describes the task, the handoff and the changed files", () => {
    const body = pullRequestBody({
      task,
      handoff: { summary: "Added refund()", changes: ["src/refund.js"], decisions: [], knownIssues: [], remainingWork: [], knowledge: [], openQuestions: [], criteria: [] },
      validation: undefined,
      changedFiles: ["src/refund.js"],
    });
    expect(body).toContain("## PAY-1: Refund\n\n### Objective\n\nAdd refunds");
    expect(body).toContain("### Summary\n\nAdded refund()");
    expect(body).not.toContain("WARNING");
  });

  it("lists the acceptance criteria as the agent checked them (spec §62)", () => {
    const body = pullRequestBody({
      task: { ...task, contract: { inputs: [], constraints: [], expectedOutput: "", acceptanceCriteria: ["Refunds are idempotent", "Docs updated"] } },
      handoff: {
        summary: "s", changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: [], openQuestions: [],
        criteria: [{ criterion: "Refunds are idempotent", met: true, evidence: "test/refund.test.js" }],
      },
      validation: undefined,
      changedFiles: [],
    });
    expect(body).toContain("### Acceptance criteria\n\n- [x] Refunds are idempotent — test/refund.test.js\n- [ ] Docs updated — not reported");
  });

  it("warns reviewers when the change touches CI configuration", () => {
    const body = pullRequestBody({ task, handoff: undefined, validation: undefined, changedFiles: ["src/a.js", ".github/workflows/ci.yml"] });
    expect(body).toContain("> [!WARNING]\n> This change modifies CI configuration (`.github/workflows/ci.yml`).");
  });
});
