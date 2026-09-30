import type { TaskDto } from "@mar/core";
import { describe, expect, it } from "vitest";
import { pullRequestBody } from "../src/pull-request.js";

const task = { key: "PAY-1", title: "Refund", objective: "Add refunds", agent: "codex" } as TaskDto;

describe("pull request body", () => {
  it("describes the task, the handoff and the changed files", () => {
    const body = pullRequestBody({
      task,
      handoff: { summary: "Added refund()", changes: ["src/refund.js"], decisions: [], knownIssues: [], remainingWork: [], knowledge: [] },
      validation: undefined,
      changedFiles: ["src/refund.js"],
    });
    expect(body).toContain("## PAY-1: Refund\n\n### Objective\n\nAdd refunds");
    expect(body).toContain("### Summary\n\nAdded refund()");
    expect(body).not.toContain("WARNING");
  });

  it("warns reviewers when the change touches CI configuration", () => {
    const body = pullRequestBody({ task, handoff: undefined, validation: undefined, changedFiles: ["src/a.js", ".github/workflows/ci.yml"] });
    expect(body).toContain("> [!WARNING]\n> This change modifies CI configuration (`.github/workflows/ci.yml`).");
  });
});
