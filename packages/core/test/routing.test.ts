import { describe, expect, it } from "vitest";
import { type AgentStats, chooseAgent, hasSkills, isAgentUnavailable, reliabilityOf } from "../src/index.js";

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
