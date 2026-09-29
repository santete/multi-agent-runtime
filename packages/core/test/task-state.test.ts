import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  TASK_STATES,
  type TaskState,
  allowedTriggers,
  isTerminal,
  transition,
} from "../src/index.js";

describe("task state machine", () => {
  it("follows the happy path from CREATED to COMPLETED", () => {
    const path = [
      "dependencies_satisfied",
      "assigned",
      "agent_started",
      "agent_completed",
      "validation_passed",
      "review_approved",
      "merge_started",
      "merge_succeeded",
    ] as const;
    const final = path.reduce<TaskState>((s, t) => transition(s, t), "CREATED");
    expect(final).toBe("COMPLETED");
  });

  it("routes validation failure, review rejection and merge conflict to REWORK", () => {
    expect(transition("VALIDATING", "validation_failed")).toBe("REWORK");
    expect(transition("REVIEW", "review_rejected")).toBe("REWORK");
    expect(transition("MERGING", "merge_conflict")).toBe("REWORK");
    expect(transition("REWORK", "rework_started")).toBe("RUNNING");
  });

  it("parks the task for a human on approval requests", () => {
    expect(transition("RUNNING", "approval_requested")).toBe("WAITING_FOR_HUMAN");
    expect(transition("WAITING_FOR_HUMAN", "approval_resolved")).toBe("RUNNING");
  });

  it("blocks after the rework/retry limit is exceeded", () => {
    expect(transition("REWORK", "limit_exceeded")).toBe("BLOCKED");
    expect(transition("RETRYING", "limit_exceeded")).toBe("BLOCKED");
    expect(transition("BLOCKED", "unblocked")).toBe("READY");
  });

  it("allows cancelling any non-terminal state", () => {
    for (const s of TASK_STATES.filter((s) => !isTerminal(s))) {
      expect(transition(s, "cancelled")).toBe("CANCELLED");
      expect(allowedTriggers(s)).toContain("cancelled");
    }
  });

  it("rejects invalid transitions, including leaving terminal states", () => {
    expect(() => transition("CREATED", "agent_completed")).toThrow(InvalidTransitionError);
    expect(() => transition("COMPLETED", "cancelled")).toThrow(InvalidTransitionError);
    expect(() => transition("CANCELLED", "unblocked")).toThrow(InvalidTransitionError);
  });

  it("never lets an agent skip validation", () => {
    expect(() => transition("RUNNING", "review_approved")).toThrow(InvalidTransitionError);
    expect(() => transition("RUNNING", "merge_started")).toThrow(InvalidTransitionError);
  });
});
