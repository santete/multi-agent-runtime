import type { ClaimResponse } from "@mar/core";
import { describe, expect, it } from "vitest";
import { agentFiles, buildPrompt, contextFiles, knowledgeFiles, reviewFiles } from "../src/context.js";

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

  it("states the task's contract, criteria numbered, and asks for a check of each (spec §62)", () => {
    const contract = { inputs: ["docs/refund-policy.md"], constraints: ["Keep the API stable"], expectedOutput: "POST /refunds", acceptanceCriteria: ["Idempotent", "Documented"] };
    const [brief] = contextFiles(claim({ task: { ...claim().task, contract, owner: "lan" } }));
    const text = String(brief!.content);
    expect(text).toContain("## Inputs\n\n- docs/refund-policy.md");
    expect(text).toContain("## Constraints\n\n- Keep the API stable");
    expect(text).toContain("## Expected output\n\nPOST /refunds");
    expect(text).toContain("## Acceptance criteria");
    expect(text).toContain("1. Idempotent\n2. Documented");
    expect(text).toContain("Owner: lan");
    expect(text).toContain("ask the task's owner in `openQuestions` which one wins");
    expect(text.indexOf("## Acceptance criteria")).toBeLessThan(text.indexOf("## Rules"));
    // Tasks without a contract keep their old brief.
    expect(String(contextFiles(claim())[0]!.content)).not.toContain("## Acceptance criteria");
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

  it("puts a person's instructions first, in full, and in INSTRUCTIONS.md (spec §43)", () => {
    const instructions = [
      { id: "i1", taskId: "t", text: "Use cents,\nnot floats.", author: "lan", createdAt: "2026-10-01T00:00:00.000Z", executionId: "e" },
    ];
    const prompt = buildPrompt(claim({ instructions }), true);
    expect(prompt).toMatch(/^A person sent you an instruction for this task/);
    expect(prompt).toContain("> Use cents,\n> not floats.\n> — lan");
    expect(prompt).toContain("You were stopped to receive this.");
    expect(prompt).not.toContain("Your previous run on this task was interrupted");
    const file = contextFiles(claim({ instructions })).find((f) => f.path.endsWith("INSTRUCTIONS.md"));
    expect(String(file?.content)).toContain("## From lan");
  });
});

describe("project knowledge", () => {
  const knowledge: NonNullable<ClaimResponse["knowledge"]> = [
    { kind: "convention", title: "ES modules only", body: "Use import/export.", source: null },
    { kind: "business_rule", title: "Amounts are integer cents", body: "Never floats.", source: "PAY-1" },
  ];

  it("writes KNOWLEDGE.md grouped by kind and points the agent at it", () => {
    const [file] = knowledgeFiles(claim({ knowledge }));
    expect(file?.path).toBe(".orchestrator/context/KNOWLEDGE.md");
    const text = String(file?.content);
    expect(text.indexOf("## Business rules")).toBeLessThan(text.indexOf("## Conventions"));
    expect(text).toContain("### Amounts are integer cents (from PAY-1)\n\nNever floats.");
    expect(buildPrompt(claim({ knowledge }), false)).toContain("KNOWLEDGE.md");
  });

  it("writes nothing when the project has no knowledge yet", () => {
    expect(knowledgeFiles(claim())).toEqual([]);
    expect(buildPrompt(claim(), false)).not.toContain("KNOWLEDGE.md");
  });
});

describe("answers from a person", () => {
  it("writes DECISIONS.md and tells the agent to continue with them", () => {
    const decisions = [{ question: "How long is the refund window?", answer: "30 days from the charge", answeredBy: "lan" }];
    const files = contextFiles(claim({ decisions }));
    const file = files.find((f) => f.path.endsWith("DECISIONS.md"));
    expect(String(file?.content)).toContain("## How long is the refund window?\n\n30 days from the charge");
    expect(buildPrompt(claim({ decisions }), true)).toMatch(/^A person answered the questions you raised/);
  });
});

describe("agent profile instructions", () => {
  it("writes AGENT.md and points the agent at it", () => {
    const c = claim({ agentInstructions: "Keep diffs small." });
    expect(agentFiles(c)).toEqual([{ path: ".orchestrator/context/AGENT.md", content: "# Your standing instructions\n\nKeep diffs small.\n", mergeJson: false }]);
    expect(buildPrompt(c, false)).toContain("AGENT.md");
    expect(agentFiles(claim())).toEqual([]);
  });
});

describe("review brief", () => {
  const target: NonNullable<ClaimResponse["review"]> = {
    taskId: "t",
    taskKey: "PAY-7",
    title: "Last four",
    objective: "Add lastFourDigits",
    branch: "task/PAY-7",
    baseBranch: "main",
    pullRequestUrl: null,
    handoff: null,
    validation: null,
    author: "codex",
    contract: { inputs: [], constraints: ["Do not modify README.md."], expectedOutput: "", acceptanceCriteria: ["README.md documents it."] },
    decisions: [{ question: "Allow the README update?", answer: "Yes, the README constraint is lifted.", answeredBy: "lan" }],
  };

  it("asks the reviewer to check each criterion, and puts people's decisions above the contract (spec §62)", () => {
    const [brief] = reviewFiles(target, "diff");
    const text = String(brief!.content);
    expect(text).toContain("1. README.md documents it.");
    expect(text).toContain("Check every acceptance criterion yourself");
    expect(text).toContain("## Decisions made by people");
    expect(text).toContain("- **Allow the README update?**\n  Yes, the README constraint is lifted. _(lan)_");
    expect(text.indexOf("## Constraints")).toBeLessThan(text.indexOf("## Decisions made by people"));
  });
});
