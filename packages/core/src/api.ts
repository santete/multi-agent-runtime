/** Wire types shared by the control plane HTTP API and its clients (runner, UI). */
import type { AdapterCapabilities, AgentEvent } from "./adapter.js";
import type { TaskState } from "./task-state.js";

/** A validation command run by the runner in the task worktree (spec §28). */
export interface ValidationStep {
  name: string;
  /** Shell command, run from the worktree root. */
  command: string;
  timeoutSeconds?: number | undefined;
}

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  /** Run in order after the agent finishes; all must pass. */
  validation: ValidationStep[];
  createdAt: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  key: string;
  title: string;
  objective: string;
  agent: string;
  state: TaskState;
  /** Attempts before the task is BLOCKED. */
  maxAttempts: number;
  /** Set once the task's branch has been delivered as a pull request. */
  pullRequestUrl: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lifecycle: assigned → running → validating → delivering → succeeded.
 * The first four are active (leased, heartbeated). `lost` = the runner
 * stopped heartbeating before the execution finished.
 */
export type ExecutionStatus =
  | "assigned"
  | "running"
  | "validating"
  | "delivering"
  | "succeeded"
  | "failed"
  | "needs_approval"
  | "cancelled"
  | "lost";

export const ACTIVE_EXECUTION_STATUSES: readonly ExecutionStatus[] = ["assigned", "running", "validating", "delivering"];

export interface ExecutionDto {
  id: string;
  taskId: string;
  runnerId: string;
  attempt: number;
  status: ExecutionStatus;
  sessionId: string | null;
  workspace: string | null;
  branch: string | null;
  exitCode: number | null;
  result: unknown;
  /** Lease held by the runner; renewed by heartbeats. */
  leaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EventDto {
  seq: number;
  id: string;
  type: string;
  projectId: string | null;
  taskId: string | null;
  executionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateProjectRequest {
  key: string;
  name: string;
  repoUrl: string;
  defaultBranch?: string | undefined;
  validation?: ValidationStep[] | undefined;
}

export type ArtifactType = "handoff" | "validation_result";

export interface ArtifactDto {
  id: string;
  projectId: string;
  taskId: string;
  executionId: string | null;
  type: ArtifactType;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface ValidationStepResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined stdout/stderr. */
  outputTail: string;
}

export interface ValidationReport {
  passed: boolean;
  steps: ValidationStepResult[];
  /** Files changed in the worktree compared to the task's base commit. */
  changedFiles: string[];
}

export interface ValidationResponse {
  /** Validation passed: commit, push and report the delivery. */
  deliver: boolean;
}

export interface DeliveryRequest {
  branch: string;
  /** Null when the task produced no file changes (nothing to push). */
  commitSha: string | null;
  changedFiles: string[];
  /** Set when committing or pushing failed; the task stays in REVIEW for a human. */
  error?: string | undefined;
}

export interface PullRequestRef {
  url: string;
  number: number;
}

export interface DeliveryResponse {
  pullRequest: PullRequestRef | null;
}

export interface CreateTaskRequest {
  title: string;
  objective: string;
  agent: string;
  maxAttempts?: number | undefined;
}

/** An agent a runner offers (agent registry, spec §14). */
export interface AgentDescriptor {
  /** Logical agent id tasks ask for, e.g. "claude-code". */
  id: string;
  /** Adapter that runs it, e.g. "claude-code", "antigravity", "generic-cli". */
  adapter: string;
  capabilities: AdapterCapabilities;
}

export interface RegisterRunnerRequest {
  /** Stable machine name; re-registering with the same name keeps the runner id. */
  name: string;
  agents: AgentDescriptor[];
}

export interface RegisterRunnerResponse {
  runnerId: string;
}

export interface RunnerDto {
  id: string;
  name: string;
  agents: AgentDescriptor[];
  online: boolean;
  registeredAt: string;
  lastSeenAt: string;
}

export interface ClaimResponse {
  execution: ExecutionDto;
  task: TaskDto;
  project: ProjectDto;
  /**
   * Secret scoped to this execution, given to the agent's policy hook. It only
   * authorizes `POST /executions/:id/tool-check`.
   */
  executionToken: string;
  /** Last agent session of this task on the same agent, if it can be resumed. */
  resume?: { sessionId: string; runnerId: string };
  /** Why the previous attempt is being reworked (spec §29). */
  rework?: ReworkContext;
}

export interface ReworkContext {
  /** Attempt that failed. */
  attempt: number;
  reason: string;
  validation?: ValidationReport;
}

export interface HeartbeatResponse {
  /** The task was cancelled: stop the agent and complete the execution. */
  cancel: boolean;
  leaseExpiresAt: string;
}

export interface ToolCheckRequest {
  tool: string;
  input: unknown;
}

export interface StartExecutionRequest {
  workspace: string;
  branch: string;
}

export interface AppendEventsRequest {
  events: AgentEvent[];
}

export interface CompleteExecutionRequest {
  exitCode: number | null;
  /** The adapter's terminal event. */
  terminal: Extract<AgentEvent, { kind: "completed" | "failed" }>;
}

export interface EventsPage {
  events: EventDto[];
  /** Pass as `after` to fetch the next page. */
  nextAfter: number;
}
