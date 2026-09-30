import type { EventDto, TaskDto, TaskState } from "@mar/core";

/** Board columns (spec §42): what a person needs to see at a glance. */
export const COLUMNS = [
  { id: "waiting", title: "Waiting", states: ["CREATED"] },
  { id: "ready", title: "Ready", states: ["READY"] },
  { id: "working", title: "Working", states: ["ASSIGNED", "RUNNING", "VALIDATING", "WAITING_FOR_AGENT"] },
  { id: "human", title: "Needs you", states: ["WAITING_FOR_HUMAN", "REVIEW", "BLOCKED"] },
  { id: "rework", title: "Rework", states: ["REWORK", "RETRYING"] },
  { id: "merging", title: "Merging", states: ["APPROVED", "MERGING"] },
  { id: "done", title: "Done", states: ["COMPLETED", "CANCELLED"] },
] as const satisfies ReadonlyArray<{ id: string; title: string; states: readonly TaskState[] }>;

export type ColumnId = (typeof COLUMNS)[number]["id"];

export function columnOf(state: TaskState): ColumnId {
  return COLUMNS.find((c) => (c.states as readonly TaskState[]).includes(state))!.id;
}

export function groupByColumn(tasks: TaskDto[]): Record<ColumnId, TaskDto[]> {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.id, [] as TaskDto[]])) as Record<ColumnId, TaskDto[]>;
  for (const t of tasks) groups[columnOf(t.state)].push(t);
  return groups;
}

/** Colour family per state, used by badges, cards and graph nodes. */
export type Tone = "neutral" | "info" | "active" | "attention" | "warning" | "success" | "danger";

export function toneOf(state: TaskState): Tone {
  switch (state) {
    case "CREATED":
    case "CANCELLED":
      return "neutral";
    case "READY":
    case "APPROVED":
    case "MERGING":
      return "info";
    case "ASSIGNED":
    case "RUNNING":
    case "VALIDATING":
    case "WAITING_FOR_AGENT":
      return "active";
    case "WAITING_FOR_HUMAN":
    case "REVIEW":
      return "attention";
    case "REWORK":
    case "RETRYING":
      return "warning";
    case "COMPLETED":
      return "success";
    case "BLOCKED":
      return "danger";
  }
}

export const stateLabel = (state: string) => state.replace(/_/g, " ").toLowerCase();

export interface LaidOutNode {
  task: TaskDto;
  layer: number;
  row: number;
}

/**
 * Layered DAG layout: a task's layer is the length of the longest dependency
 * chain before it; rows keep creation order within a layer.
 */
export function layoutGraph(tasks: TaskDto[]): LaidOutNode[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layer = new Map<string, number>();
  const depth = (t: TaskDto, seen: Set<string> = new Set()): number => {
    const known = layer.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0; // defensive: the API never produces cycles
    seen.add(t.id);
    const deps = t.dependsOn.map((id) => byId.get(id)).filter((d): d is TaskDto => Boolean(d));
    const d = deps.length ? Math.max(...deps.map((x) => depth(x, seen))) + 1 : 0;
    layer.set(t.id, d);
    return d;
  };
  const rows = new Map<number, number>();
  return [...tasks]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((task) => {
      const l = depth(task);
      const row = rows.get(l) ?? 0;
      rows.set(l, row + 1);
      return { task, layer: l, row };
    });
}

export function countByState(tasks: TaskDto[]): Partial<Record<TaskState, number>> {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** One line describing an event for timelines and the activity feed. */
export function describeEvent(e: EventDto): string {
  const p = e.payload as Record<string, any>;
  const by = p.actor ? ` by ${p.actor}` : "";
  switch (e.type) {
    case "TaskCreated":
      return `created "${p.title}" for ${p.agent}${p.dependsOn?.length ? ` after ${p.dependsOn.join(", ")}` : ""}${by}`;
    case "TaskStateChanged":
      return `${stateLabel(p.from)} → ${stateLabel(p.to)}${p.comment ? ` — “${p.comment}”` : ""}${by}`;
    case "ExecutionAssigned":
      return `attempt ${p.attempt} assigned${p.resumable ? " (resuming session)" : ""}${p.rework ? `, rework: ${p.rework}` : ""}`;
    case "ExecutionStarted":
      return `started on ${p.branch}`;
    case "AgentFinished":
      return `agent finished: ${p.status}`;
    case "ToolCallChecked":
      return `${p.decision === "allow" ? "allowed" : "denied"} ${p.summary} [${p.risk}]`;
    case "ApprovalRequested":
      return `approval requested: ${p.summary}`;
    case "ApprovalGranted":
      return `approved ${p.summary}${p.actor ? ` by ${p.actor}` : ""}`;
    case "ApprovalRejected":
      return `rejected ${p.summary}${p.actor ? ` by ${p.actor}` : ""}`;
    case "ValidationPassed":
      return "validation passed";
    case "ValidationFailed":
      return `validation failed (${(p.steps ?? []).filter((s: any) => !s.passed).map((s: any) => s.name).join(", ")})`;
    case "BranchPushed":
      return `pushed ${p.branch}`;
    case "PullRequestOpened":
      return `pull request #${p.number} opened`;
    case "PullRequestSkipped":
      return `pull request skipped: ${p.reason}`;
    case "TaskMerged":
      return "merged";
    case "ExecutionLost":
      return `runner lost during ${p.phase ?? "execution"}`;
    case "ArtifactCreated":
      return `${String(p.type).replace("_", " ")} recorded`;
    case "AgentEvent":
      return describeAgentEvent(p);
    default:
      return e.type;
  }
}

function describeAgentEvent(p: Record<string, any>): string {
  switch (p.kind) {
    case "session_started":
      return `session ${String(p.sessionId).slice(0, 8)}`;
    case "message":
      return p.text;
    case "tool_call":
      return `→ ${p.tool} ${summarizeInput(p.input)}`;
    case "tool_result":
      return `${p.ok ? "✓" : "✗"} ${p.tool ?? ""}${p.output && !p.ok ? `: ${String(p.output).slice(0, 200)}` : ""}`;
    case "permission_denied":
      return `denied ${p.tool}`;
    case "diagnostic":
      return p.text;
    case "completed":
      return `completed (${p.success ? "success" : "not successful"})${p.costUsd ? ` · $${p.costUsd.toFixed(2)}` : ""}`;
    case "failed":
      return `failed: ${p.reason}`;
    default:
      return p.kind;
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.CommandLine ?? i.file_path ?? i.TargetFile ?? i.path ?? i.pattern;
  return typeof v === "string" ? v.slice(0, 160) : "";
}
