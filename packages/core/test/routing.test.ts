import { describe, expect, it } from "vitest";
import { type AgentSkillStats, type AgentStats, chooseAgent, failureText, hasSkills, isAgentUnavailable, qualityOf, reliabilityOf } from "../src/index.js";
import { isContextOverflow } from "../src/index.js";

const claude = { id: "claude-code", skills: ["typescript", "backend", "review"], cost: "high" as const };
const codex = { id: "codex", skills: ["typescript", "backend", "review"], cost: "medium" as const };
const agy = { id: "antigravity", skills: ["typescript", "frontend"], cost: "low" as const };
const stats = (agent: string, succeeded: number, failed: number, active = 0): AgentStats => ({
  agent,
  executions: succeeded + failed,
  succeeded,
  failed,
  active,
  avgDurationMs: null,
  reworkRate: 0,
});

describe("chooseAgent", () => {
  it("only considers agents with every required skill and not excluded", () => {
    expect(chooseAgent([claude, codex, agy], { requires: ["frontend"], excluded: [] }, [])?.agent).toBe("antigravity");
    expect(chooseAgent([claude, codex, agy], { requires: ["backend"], excluded: ["codex"] }, [])?.agent).toBe("claude-code");
    expect(chooseAgent([agy], { requires: ["backend"], excluded: [] }, [])).toBeNull();
  });

  it("prefers the measured more reliable agent", () => {
    const choice = chooseAgent([claude, codex], { requires: ["backend"], excluded: [] }, [stats("codex", 1, 6), stats("claude-code", 9, 1)]);
    expect(choice).toMatchObject({ agent: "claude-code", reason: expect.stringContaining("9/10 runs") });
  });

  it("lets the policy trade reliability for cost", () => {
    const history = [stats("claude-code", 8, 1), stats("codex", 7, 2)];
    expect(chooseAgent([claude, codex], { requires: [], excluded: [] }, history, "reliability")?.agent).toBe("claude-code");
    expect(chooseAgent([claude, codex], { requires: [], excluded: [] }, history, "cost")?.agent).toBe("codex");
  });

  it("spreads load away from busy agents when otherwise equal", () => {
    const twin = { ...codex, id: "codex-2" };
    expect(chooseAgent([codex, twin], { requires: [], excluded: [] }, [stats("codex", 5, 0, 4), stats("codex-2", 5, 0, 0)])?.agent).toBe(
      "codex-2",
    );
  });

  it("matches skills case-insensitively", () => {
    expect(hasSkills(claude, ["TypeScript", " Backend "])).toBe(true);
  });
});

describe("helpers", () => {
  it("smooths reliability towards a prior", () => {
    expect(reliabilityOf(undefined)).toBeCloseTo(0.8);
    expect(reliabilityOf(stats("x", 1, 0))).toBeCloseTo(0.867, 2);
    expect(reliabilityOf(stats("x", 0, 10))).toBeLessThan(0.2);
  });

  it("recognizes agent-unavailable failures", () => {
    expect(isAgentUnavailable("Claude AI usage limit reached")).toBe(true);
    expect(isAgentUnavailable("quota exceeded")).toBe(true);
    expect(isAgentUnavailable("Rate limit hit")).toBe(true);
    expect(isAgentUnavailable("process exited with code 1 without a result")).toBe(false);
  });
});

describe("selection by measured results (spec §40)", () => {
  const skill = (agent: string, name: string, succeeded: number, failed: number): AgentSkillStats => ({
    agent,
    skill: name,
    succeeded,
    failed,
    reworked: 0,
  });

  it("prefers the agent that does well on the task's skill, even if it is weaker overall", () => {
    const history = [stats("claude-code", 8, 2), stats("codex", 7, 3)];
    const skills = [skill("claude-code", "frontend", 0, 4), skill("codex", "frontend", 5, 0)];
    const both = [
      { ...claude, skills: [...claude.skills, "frontend"] },
      { ...codex, cost: "high" as const, skills: [...codex.skills, "frontend"] },
    ];
    const choice = chooseAgent(both, { requires: ["frontend"], excluded: [] }, history, "reliability", skills)!;
    expect(choice.agent).toBe("codex");
    expect(choice.reason).toContain("5/5 on frontend");
    // Without a skill record, the overall record decides.
    expect(chooseAgent(both, { requires: ["frontend"], excluded: [] }, history, "reliability")!.agent).toBe("claude-code");
  });

  it("anchors a thin skill record to the overall one", () => {
    const s = stats("codex", 18, 2);
    const one = qualityOf(s, [skill("codex", "sql", 0, 1)], ["sql"]).quality;
    expect(one).toBeGreaterThan(0.6);
    expect(qualityOf(s, [skill("codex", "sql", 0, 10)], ["sql"]).quality).toBeLessThan(0.3);
  });

  it("counts rework and human interventions against an agent", () => {
    const clean = { ...stats("a", 9, 1), reworkRate: 0, humanInterventions: 0 };
    const sloppy = { ...stats("a", 9, 1), reworkRate: 0.6, humanInterventions: 5 };
    expect(qualityOf(sloppy, [], []).quality).toBeLessThan(qualityOf(clean, [], []).quality * 0.65);
  });

  it("weighs speed under the speed policy", () => {
    const fast = { ...stats("codex", 9, 1), avgDurationMs: 60_000 };
    const slow = { ...stats("claude-code", 9, 1), avgDurationMs: 600_000 };
    const pair = [claude, { ...codex, cost: "high" as const }];
    expect(chooseAgent(pair, { requires: [], excluded: [] }, [fast, slow], "speed")!).toMatchObject({
      agent: "codex",
      reason: expect.stringContaining("avg 60s"),
    });
  });
});

describe("failures found live", () => {
  it("recognizes Claude's session limit, reported as an unsuccessful result", () => {
    const t = { kind: "completed", success: false, result: "You've hit your session limit · resets 12:20pm (Asia/Ho_Chi_Minh)" };
    expect(failureText(t)).toContain("session limit");
    expect(isAgentUnavailable(failureText(t))).toBe(true);
    expect(failureText({ kind: "completed", success: true, result: "done" })).toBe("");
    expect(failureText({ kind: "failed", reason: "boom" })).toBe("boom");
  });
});

describe("isContextOverflow", () => {
  it("recognizes agents that ran out of context", () => {
    for (const reason of ["Prompt is too long", "context window exceeded", "This model's maximum context length is 200000 tokens", "context_length_exceeded"]) {
      expect(isContextOverflow(reason)).toBe(true);
    }
    expect(isContextOverflow("validation failed: test")).toBe(false);
    expect(isContextOverflow("rate limit reached")).toBe(false);
  });
});
