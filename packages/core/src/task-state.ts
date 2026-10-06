/**
 * Task lifecycle (normalized version of product-spec §12, see ADR-0005).
 *
 * WAITING_FOR_DEPENDENCY is derived from the DAG and never stored, so it is
 * intentionally absent here.
 */
export const TASK_STATES = [
  "CREATED",
  "READY",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_HUMAN",
  "WAITING_FOR_AGENT",
  "VALIDATING",
  "REVIEW",
  "APPROVED",
  "MERGING",
  "COMPLETED",
  "REWORK",
  "RETRYING",
  "BLOCKED",
  /** Stopped by a person (spec §43); resuming continues the agent session. */
  "PAUSED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export type TaskTransitionTrigger =
  | "dependencies_satisfied"
  | "merge_by_person"
  | "merged_by_person"
  | "assigned"
  | "unassigned"
  | "agent_started"
  | "approval_requested"
  | "approval_resolved"
  | "agent_unavailable"
  | "agent_available"
  | "agent_completed"
  | "agent_failed"
  | "validation_passed"
  | "validation_failed"
  | "review_approved"
  | "review_rejected"
  | "merge_started"
  | "merge_succeeded"
  | "merge_conflict"
  | "rework_started"
  | "retry_started"
  | "limit_exceeded"
  | "unblocked"
  | "review_submitted"
  | "base_changed"
  | "ci_failed"
  | "human_completed"
  | "paused"
  | "resumed"
  | "interrupted"
  | "cancelled";

type TransitionTable = Partial<Record<TaskState, Partial<Record<TaskTransitionTrigger, TaskState>>>>;

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["COMPLETED", "CANCELLED"]);

const TRANSITIONS: TransitionTable = {
  CREATED: { dependencies_satisfied: "READY" },
  // human_completed: a person did a task assigned to "human" (spec §61).
  READY: { assigned: "ASSIGNED", human_completed: "COMPLETED", paused: "PAUSED" },
  ASSIGNED: {
    agent_started: "RUNNING",
    unassigned: "READY",
    agent_unavailable: "WAITING_FOR_AGENT",
    // e.g. the runner could not prepare the workspace
    agent_failed: "RETRYING",
    paused: "PAUSED",
    interrupted: "READY",
  },
  RUNNING: {
    // Review tasks produce a review, not code: no validation, delivery or merge.
    review_submitted: "COMPLETED",
    approval_requested: "WAITING_FOR_HUMAN",
    agent_completed: "VALIDATING",
    agent_failed: "RETRYING",
    agent_unavailable: "WAITING_FOR_AGENT",
    // Spec §43: a person paused the agent, or interrupted it with a new instruction.
    paused: "PAUSED",
    interrupted: "READY",
  },
  // unassigned: approvals decided (or a human asked to retry), back to the queue.
  // merged_by_person: a person merged an approved branch that had no pull request.
  WAITING_FOR_HUMAN: { approval_resolved: "RUNNING", unassigned: "READY", merged_by_person: "COMPLETED" },
  WAITING_FOR_AGENT: { agent_available: "RUNNING", unassigned: "READY" },
  // agent_failed: the runner was lost while validating.
  VALIDATING: { validation_passed: "REVIEW", validation_failed: "REWORK", agent_failed: "RETRYING" },
  REVIEW: { review_approved: "APPROVED", review_rejected: "REWORK" },
  APPROVED: { merge_started: "MERGING" },
  // limit_exceeded: the merge kept failing for reasons other than a conflict.
  // base_changed: the base moved since validation, re-validate first; ci_failed: CI checks failed.
  MERGING: {
    merge_succeeded: "COMPLETED",
    merge_conflict: "REWORK",
    base_changed: "REWORK",
    ci_failed: "REWORK",
    limit_exceeded: "BLOCKED",
    // Approved changes with no pull request (no provider for the repository, or opening it failed).
    merge_by_person: "WAITING_FOR_HUMAN",
  },
  // Requeued ("unassigned") so any runner offering the agent can pick it up again.
  REWORK: { rework_started: "RUNNING", unassigned: "READY", limit_exceeded: "BLOCKED", paused: "PAUSED" },
  RETRYING: { retry_started: "RUNNING", unassigned: "READY", limit_exceeded: "BLOCKED", paused: "PAUSED" },
  PAUSED: { resumed: "READY" },
  BLOCKED: { unblocked: "READY" },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly trigger: TaskTransitionTrigger,
  ) {
    super(`Invalid task transition: ${from} --${trigger}-->`);
    this.name = "InvalidTransitionError";
  }
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/** Returns the next state, or throws if the trigger is not allowed from `from`. */
export function transition(from: TaskState, trigger: TaskTransitionTrigger): TaskState {
  // Any non-terminal task can be cancelled.
  if (trigger === "cancelled" && !isTerminal(from)) return "CANCELLED";
  const next = TRANSITIONS[from]?.[trigger];
  if (!next) throw new InvalidTransitionError(from, trigger);
  return next;
}

export function allowedTriggers(from: TaskState): TaskTransitionTrigger[] {
  const triggers = Object.keys(TRANSITIONS[from] ?? {}) as TaskTransitionTrigger[];
  return isTerminal(from) ? triggers : [...triggers, "cancelled"];
}
