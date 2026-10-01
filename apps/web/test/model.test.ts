import type { EventDto, TaskDto, TaskState } from "@mar/core";
import { TASK_STATES } from "@mar/core";
import { describe, expect, it } from "vitest";
import { COLUMNS, columnOf, countByState, describeEvent, groupByColumn, layoutGraph, timeAgo, toneOf } from "../src/lib/model.js";

const task = (id: string, state: TaskState, dependsOn: string[] = [], createdAt = `2026-09-30T00:00:0${id}Z`) =>
  ({ id, key: `P-${id}`, title: id, state, dependsOn, createdAt }) as TaskDto;

describe("board columns", () => {
  it("places every task state in exactly one column", () => {
    const all = COLUMNS.flatMap((c) => c.states);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(TASK_STATES.length);
  });

  it("groups tasks", () => {
    const g = groupByColumn([task("1", "READY"), task("2", "REVIEW"), task("3", "WAITING_FOR_HUMAN"), task("4", "COMPLETED")]);
    expect(g.ready.map((t) => t.id)).toEqual(["1"]);
    expect(g.human.map((t) => t.id)).toEqual(["2", "3"]);
    expect(g.done.map((t) => t.id)).toEqual(["4"]);
    expect(columnOf("MERGING")).toBe("merging");
    expect(toneOf("BLOCKED")).toBe("danger");
  });

  it("counts tasks per state", () => {
    expect(countByState([task("1", "READY"), task("2", "READY"), task("3", "REVIEW")])).toEqual({ READY: 2, REVIEW: 1 });
  });
});

describe("layoutGraph", () => {
  it("layers tasks by their longest dependency chain", () => {
    // 1 -> 2, 1 -> 3, (2, 3) -> 4, and 5 depends on 1 and 4
    const nodes = layoutGraph([
      task("1", "COMPLETED"),
      task("2", "RUNNING", ["1"]),
      task("3", "RUNNING", ["1"]),
      task("4", "CREATED", ["2", "3"]),
      task("5", "CREATED", ["1", "4"]),
    ]);
    const at = Object.fromEntries(nodes.map((n) => [n.task.id, [n.layer, n.row]]));
    expect(at).toEqual({ "1": [0, 0], "2": [1, 0], "3": [1, 1], "4": [2, 0], "5": [3, 0] });
  });

  it("ignores dependencies outside the given tasks", () => {
    expect(layoutGraph([task("1", "READY", ["missing"])])[0]).toMatchObject({ layer: 0, row: 0 });
  });
});

describe("formatting", () => {
  it("describes events", () => {
    const e = (type: string, payload: object) => ({ type, payload }) as EventDto;
    expect(describeEvent(e("TaskStateChanged", { from: "REVIEW", to: "APPROVED", actor: "sam" }))).toBe(
      "review → approved by sam",
    );
    expect(describeEvent(e("ToolCallChecked", { decision: "deny", summary: "Bash: git push", risk: "CRITICAL" }))).toBe(
      "denied Bash: git push [CRITICAL]",
    );
    expect(describeEvent(e("AgentEvent", { kind: "tool_call", tool: "Write", input: { file_path: "src/a.ts" } }))).toBe(
      "→ Write src/a.ts",
    );
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(timeAgo("2026-09-30T11:59:30Z", now)).toBe("30s ago");
    expect(timeAgo("2026-09-30T11:00:00Z", now)).toBe("1h ago");
    expect(timeAgo("2026-09-30T11:15:00Z", now)).toBe("45m ago");
    expect(timeAgo("2026-09-28T12:00:00Z", now)).toBe("2d ago");
  });
});
