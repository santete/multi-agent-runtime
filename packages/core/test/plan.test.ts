import { describe, expect, it } from "vitest";
import { balanceBrackets, checkPlan, MAX_PLAN_TASKS, parseJsonAnswer } from "../src/index.js";

const task = (ref: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  ref,
  title: `Task ${ref}`,
  objective: `Do ${ref}`,
  agent: null,
  requires: [],
  dependsOn,
  ...extra,
});

describe("checkPlan", () => {
  it("returns the tasks in dependency order, keeping the proposal's order otherwise", () => {
    const check = checkPlan({ summary: "s", tasks: [task("T3", ["T1", "T2"]), task("T1"), task("T2", ["T1"])] });
    expect(check.ok && check.plan.tasks.map((t) => t.ref)).toEqual(["T1", "T2", "T3"]);
  });

  it("keeps dependencies on existing tasks", () => {
    const check = checkPlan({ summary: "", tasks: [task("T1", ["PAY-3"])] });
    expect(check.ok && check.plan.tasks[0]!.dependsOn).toEqual(["PAY-3"]);
  });

  it("rejects cycles, duplicate refs, empty and oversized plans", () => {
    expect(checkPlan({ tasks: [task("A", ["B"]), task("B", ["A"])] })).toEqual({ ok: false, error: "dependency cycle between A, B" });
    expect(checkPlan({ tasks: [task("A"), task("A")] })).toMatchObject({ ok: false, error: "duplicate task ref A" });
    expect(checkPlan({ tasks: [task("A", ["A"])] })).toMatchObject({ ok: false });
    expect(checkPlan({ tasks: [] })).toMatchObject({ ok: false });
    // A planner may find nothing to do.
    expect(checkPlan({ summary: "done already", tasks: [] }, { allowEmpty: true })).toEqual({
      ok: true,
      plan: { summary: "done already", tasks: [], knowledge: [] },
    });
    expect(checkPlan({ tasks: Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => task(`T${i}`)) })).toMatchObject({ ok: false });
    expect(checkPlan({ tasks: [task("A", [], { objective: " " })] })).toMatchObject({ ok: false });
    expect(checkPlan(null)).toMatchObject({ ok: false });
  });

  it("normalizes loose values", () => {
    const check = checkPlan({ tasks: [{ title: " T ", objective: "O", agent: "", requires: ["ts", 3, " "], dependsOn: "x" }] });
    expect(check).toEqual({
      ok: true,
      plan: { summary: "", tasks: [{ ref: "T1", title: "T", objective: "O", agent: null, requires: ["ts"], dependsOn: [], paths: [], inputs: [], constraints: [], expectedOutput: "", acceptanceCriteria: [] }], knowledge: [] },
    });
  });

  it("reads JSON from a text answer", () => {
    const json = JSON.stringify({ summary: "s", tasks: [task("T1")] });
    expect(checkPlan(json).ok).toBe(true);
    expect(checkPlan(`Here is the plan:\n\`\`\`json\n${json}\n\`\`\`\nDone.`).ok).toBe(true);
    expect(checkPlan(`Plan: ${json} — that's it`).ok).toBe(true);
    expect(checkPlan("no plan here")).toEqual({ ok: false, error: "the plan is not valid JSON" });
  });
});

describe("checkPlan: tasks for people", () => {
  it("gives a human task no paths", () => {
    const check = checkPlan({ tasks: [{ ref: "T1", title: "Decide", objective: "o", agent: "human", paths: [".orchestrator/context/DECISIONS.md"] }] });
    expect(check.ok && check.plan.tasks[0]!.paths).toEqual([]);
  });
});

describe("parseJsonAnswer", () => {
  it("reads the object from plain, fenced or surrounded answers", () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here it is:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Done. {"a":1} Bye.')).toEqual({ a: 1 });
    expect(parseJsonAnswer("no json")).toBeUndefined();
  });

  it("closes brackets a model left out (seen live: an array closed with a brace)", () => {
    const broken = '{"tasks":[{"ref":"T1","acceptanceCriteria":["a","b"}],"knowledge":[]}';
    expect(parseJsonAnswer(broken)).toEqual({ tasks: [{ ref: "T1", acceptanceCriteria: ["a", "b"] }], knowledge: [] });
    expect(parseJsonAnswer('{"summary":"cut off","tasks":[{"ref":"T1"')).toEqual({ summary: "cut off", tasks: [{ ref: "T1" }] });
  });
});

describe("balanceBrackets", () => {
  it("leaves brackets inside strings alone", () => {
    expect(balanceBrackets('{"a":"x}]{[","b":["c"}')).toBe('{"a":"x}]{[","b":["c"]}');
    expect(balanceBrackets('{"a":"say \\"}\\" ok"')).toBe('{"a":"say \\"}\\" ok"}');
  });
});
