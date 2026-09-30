/** Wire types shared by the control plane HTTP API and its clients (runner, UI). */
import type { AgentEvent } from "./adapter.js";
import type { TaskState } from "./task-state.js";

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
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
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionStatus = "assigned" | "running" | "succeeded" | "failed" | "needs_approval";

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
}

export interface CreateTaskRequest {
  title: string;
  objective: string;
  agent: string;
}

export interface RegisterRunnerRequest {
  name: string;
  /** Logical agent ids this runner can execute. */
  agents: string[];
}

export interface RegisterRunnerResponse {
  runnerId: string;
}

export interface ClaimResponse {
  execution: ExecutionDto;
  task: TaskDto;
  project: ProjectDto;
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
