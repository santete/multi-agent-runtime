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
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export type TaskTransitionTrigger =
  | "dependencies_satisfied"
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
  | "cancelled";

type TransitionTable = Partial<Record<TaskState, Partial<Record<TaskTransitionTrigger, TaskState>>>>;

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["COMPLETED", "CANCELLED"]);

const TRANSITIONS: TransitionTable = {
  CREATED: { dependencies_satisfied: "READY" },
  READY: { assigned: "ASSIGNED" },
  ASSIGNED: {
    agent_started: "RUNNING",
    unassigned: "READY",
    agent_unavailable: "WAITING_FOR_AGENT",
    // e.g. the runner could not prepare the workspace
    agent_failed: "RETRYING",
  },
  RUNNING: {
    approval_requested: "WAITING_FOR_HUMAN",
    agent_completed: "VALIDATING",
    agent_failed: "RETRYING",
    agent_unavailable: "WAITING_FOR_AGENT",
  },
  WAITING_FOR_HUMAN: { approval_resolved: "RUNNING" },
  WAITING_FOR_AGENT: { agent_available: "RUNNING", unassigned: "READY" },
  VALIDATING: { validation_passed: "REVIEW", validation_failed: "REWORK" },
  REVIEW: { review_approved: "APPROVED", review_rejected: "REWORK" },
  APPROVED: { merge_started: "MERGING" },
  MERGING: { merge_succeeded: "COMPLETED", merge_conflict: "REWORK" },
  REWORK: { rework_started: "RUNNING", limit_exceeded: "BLOCKED" },
  RETRYING: { retry_started: "RUNNING", unassigned: "READY", limit_exceeded: "BLOCKED" },
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
