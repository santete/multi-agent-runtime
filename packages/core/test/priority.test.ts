import { describe, expect, it } from "vitest";
import { effectivePriority, transitiveDependents } from "../src/index.js";

describe("effectivePriority", () => {
  it("adds the critical path, aging and unblocking work to the task's priority", () => {
    expect(effectivePriority({ priority: 50, dependents: 0, waitingMinutes: 5, kind: "work" })).toEqual({ score: 50, reasons: ["priority 50"] });
    expect(effectivePriority({ priority: 50, dependents: 2, waitingMinutes: 35, kind: "review" })).toEqual({
      score: 73,
      reasons: ["priority 50", "+10 unblocks 2 tasks", "+3 waiting 35 min", "+10 review unblocks people"],
    });
  });

  it("caps the bonuses so a person's priority still matters", () => {
    expect(effectivePriority({ priority: 0, dependents: 20, waitingMinutes: 10_000, kind: "work" }).score).toBe(50);
    expect(effectivePriority({ priority: 100, dependents: 0, waitingMinutes: 0, kind: "work" }).score).toBe(100);
  });
});

describe("transitiveDependents", () => {
  it("counts everything waiting on a task, directly or not", () => {
    const counts = transitiveDependents([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
      { id: "e", dependsOn: [] },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ a: 3, b: 1, c: 1, d: 0, e: 0 });
  });
});
