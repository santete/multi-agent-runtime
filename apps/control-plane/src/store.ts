import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AgentDescriptor,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalDto,
  type ArtifactDto,
  type ArtifactType,
  type ClaimResponse,
  type CompleteExecutionRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type DeliveryRequest,
  type DeliveryResponse,
  type DependencyContext,
  type EventDto,
  type ExecutionDto,
  type ExecutionStatus,
  type Handoff,
  type HeartbeatResponse,
  type PolicyVerdict,
  type ProjectDto,
  type ReworkContext,
  type ReviewRequest,
  type RunnerDto,
  type TaskDto,
  type TaskGraph,
  type TaskState,
  type TaskTransitionTrigger,
  type ToolCheckRequest,
  type ValidationReport,
  type ValidationResponse,
  type ValidationStep,
  ACTIVE_EXECUTION_STATUSES,
  approvalKey,
  evaluateToolCall,
  isTerminal,
  toHandoff,
  transition,
} from "@mar/core";
import type { Db, Queryable } from "./db.js";
import type { GitProvider, MergeResult } from "./git-provider.js";
import { pullRequestBody } from "./pull-request.js";

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface StoreOptions {
  /** How long an execution lease lasts without a heartbeat. */
  leaseSeconds?: number;
  /** A runner counts as online if seen within this window. */
  runnerOnlineSeconds?: number;
  /** Opens pull requests for delivered tasks; without one, delivery stops at the pushed branch. */
  gitProvider?: GitProvider | undefined;
}

type Row = Record<string, any>;

const ACTIVE = [...ACTIVE_EXECUTION_STATUSES];

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const toProject = (r: Row): ProjectDto => ({
  id: r.id,
  key: r.key,
  name: r.name,
  repoUrl: r.repo_url,
  defaultBranch: r.default_branch,
  validation: r.validation ?? [],
  maxParallel: r.max_parallel ?? null,
  createdAt: iso(r.created_at),
});

const toArtifact = (r: Row): ArtifactDto => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  executionId: r.execution_id,
  type: r.type,
  content: r.content,
  createdAt: iso(r.created_at),
});

const toApproval = (r: Row): ApprovalDto => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  executionId: r.execution_id,
  tool: r.tool,
  input: r.input,
  summary: r.summary,
  risk: r.risk,
  reason: r.reason,
  status: r.status,
  comment: r.comment ?? null,
  createdAt: iso(r.created_at),
  decidedAt: isoOrNull(r.decided_at),
});

const toTask = (r: Row): TaskDto => ({
  id: r.id,
  projectId: r.project_id,
  key: r.key,
  title: r.title,
  objective: r.objective,
  agent: r.agent,
  state: r.state,
  maxAttempts: r.max_attempts,
  dependsOn: r.depends_on ?? [],
  pullRequestUrl: r.pull_request_url ?? null,
  pullRequestNumber: r.pull_request_number ?? null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toExecution = (r: Row): ExecutionDto => ({
  id: r.id,
  taskId: r.task_id,
  runnerId: r.runner_id,
  attempt: r.attempt,
  status: r.status,
  sessionId: r.session_id,
  workspace: r.workspace,
  branch: r.branch,
  exitCode: r.exit_code,
  result: r.result ?? null,
  leaseExpiresAt: isoOrNull(r.lease_expires_at),
  createdAt: iso(r.created_at),
  startedAt: isoOrNull(r.started_at),
  finishedAt: isoOrNull(r.finished_at),
});

const toEvent = (r: Row): EventDto => ({
  seq: Number(r.seq),
  id: r.id,
  type: r.type,
  projectId: r.project_id,
  taskId: r.task_id,
  executionId: r.execution_id,
  payload: r.payload,
  createdAt: iso(r.created_at),
});

interface NewEvent {
  type: string;
  projectId?: string | null;
  taskId?: string | null;
  executionId?: string | null;
  payload?: Record<string, unknown>;
}

async function appendEvent(q: Queryable, e: NewEvent): Promise<void> {
  await q.query(
    "insert into events (id, type, project_id, task_id, execution_id, payload) values ($1, $2, $3, $4, $5, $6)",
    [randomUUID(), e.type, e.projectId ?? null, e.taskId ?? null, e.executionId ?? null, JSON.stringify(e.payload ?? {})],
  );
}

async function one<T>(rows: Promise<Row[]>, map: (r: Row) => T, what: string, id: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw new NotFoundError(what, id);
  return map(row);
}

/**
 * Moves a task through the state machine with optimistic locking and records
 * a TaskStateChanged event. All state changes must go through here.
 */
async function changeTaskState(
  q: Queryable,
  task: TaskDto,
  trigger: TaskTransitionTrigger,
  payload: Record<string, unknown> = {},
): Promise<TaskDto> {
  const to: TaskState = transition(task.state, trigger);
  const [row] = await q.query(
    "update tasks set state = $1, version = version + 1, updated_at = now() where id = $2 and version = $3 returning *",
    [to, task.id, task.version],
  );
  if (!row) throw new ConflictError(`task ${task.key} was modified concurrently`);
  await appendEvent(q, {
    type: "TaskStateChanged",
    projectId: task.projectId,
    taskId: task.id,
    payload: { from: task.state, to, trigger, ...payload },
  });
  return toTask(row);
}

export interface MergeQueueResult {
  merged: number;
  conflicts: number;
  failed: number;
}

/** Merge attempts that fail for reasons other than a conflict before the task is BLOCKED. */
const MAX_MERGE_FAILURES = 3;

export interface SweepResult {
  lost: number;
  requeued: number;
  blocked: number;
}

export class Store {
  private readonly leaseSeconds: number;
  private readonly runnerOnlineSeconds: number;
  private readonly gitProvider: GitProvider | undefined;

  constructor(
    private readonly db: Db,
    options: StoreOptions = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.runnerOnlineSeconds = options.runnerOnlineSeconds ?? 30;
    this.gitProvider = options.gitProvider;
  }

  // ---- projects -----------------------------------------------------------

  async createProject(req: CreateProjectRequest): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const existing = await q.query("select 1 from projects where key = $1", [req.key]);
      if (existing.length) throw new ConflictError(`project key already exists: ${req.key}`);
      const [row] = await q.query(
        `insert into projects (id, key, name, repo_url, default_branch, validation, max_parallel)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          randomUUID(),
          req.key,
          req.name,
          req.repoUrl,
          req.defaultBranch ?? "main",
          JSON.stringify(req.validation ?? []),
          req.maxParallel ?? null,
        ],
      );
      const project = toProject(row!);
      await appendEvent(q, { type: "ProjectCreated", projectId: project.id, payload: { key: project.key } });
      return project;
    });
  }

  listProjects(): Promise<ProjectDto[]> {
    return this.db.query("select * from projects order by created_at").then((rows) => rows.map(toProject));
  }

  getProject(id: string, q: Queryable = this.db): Promise<ProjectDto> {
    return one(q.query("select * from projects where id = $1", [id]), toProject, "project", id);
  }

  async setValidation(id: string, steps: ValidationStep[]): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const project = await one(
        q.query("update projects set validation = $2 where id = $1 returning *", [id, JSON.stringify(steps)]),
        toProject,
        "project",
        id,
      );
      await appendEvent(q, {
        type: "ProjectValidationChanged",
        projectId: id,
        payload: { steps: steps.map((s) => s.name) },
      });
      return project;
    });
  }

  // ---- tasks --------------------------------------------------------------

  async createTask(projectId: string, req: CreateTaskRequest): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const [p] = await q.query<{ key: string; task_seq: number }>(
        "update projects set task_seq = task_seq + 1 where id = $1 returning key, task_seq",
        [projectId],
      );
      if (!p) throw new NotFoundError("project", projectId);
      const key = `${p.key}-${p.task_seq}`;
      const deps = await this.resolveDependencies(q, projectId, req.dependsOn ?? []);
      const [row] = await q.query(
        `insert into tasks (id, project_id, key, title, objective, agent, state, max_attempts, depends_on)
         values ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8::uuid[]) returning *`,
        [randomUUID(), projectId, key, req.title, req.objective, req.agent, req.maxAttempts ?? 3, deps.map((d) => d.id)],
      );
      const task = toTask(row!);
      await appendEvent(q, {
        type: "TaskCreated",
        projectId,
        taskId: task.id,
        payload: { key, title: task.title, agent: task.agent, dependsOn: deps.map((d) => d.key) },
      });
      if (deps.every((d) => d.state === "COMPLETED")) return changeTaskState(q, task, "dependencies_satisfied");
      return task; // stays CREATED (waiting for dependencies) until they are merged
    });
  }

  /** Resolves ids or keys of existing tasks in the same project; unknown or foreign tasks are rejected. */
  private async resolveDependencies(q: Queryable, projectId: string, refs: string[]): Promise<TaskDto[]> {
    if (!refs.length) return [];
    const unique = [...new Set(refs)];
    const rows = await q.query(
      "select * from tasks where project_id = $1 and (id::text = any($2::text[]) or key = any($2::text[]))",
      [projectId, unique],
    );
    const found = rows.map(toTask);
    const missing = unique.filter((r) => !found.some((t) => t.id === r || t.key === r));
    if (missing.length) throw new ConflictError(`unknown dependencies in this project: ${missing.join(", ")}`);
    return found;
  }

  /** Moves CREATED tasks whose dependencies are now all COMPLETED to READY. */
  private async unlockDependents(q: Queryable, completed: TaskDto): Promise<void> {
    const waiting = await q.query(
      `select * from tasks t where t.state = 'CREATED' and $1::uuid = any(t.depends_on)
         and not exists (select 1 from tasks d where d.id = any(t.depends_on) and d.state <> 'COMPLETED')
       for update`,
      [completed.id],
    );
    for (const row of waiting) {
      await changeTaskState(q, toTask(row), "dependencies_satisfied", { unlockedBy: completed.key });
    }
  }

  async graph(projectId: string): Promise<TaskGraph> {
    await this.getProject(projectId);
    const nodes = await this.listTasks(projectId);
    return { nodes, edges: nodes.flatMap((t) => t.dependsOn.map((from) => ({ from, to: t.id }))) };
  }

  listTasks(projectId: string): Promise<TaskDto[]> {
    return this.db
      .query("select * from tasks where project_id = $1 order by created_at", [projectId])
      .then((rows) => rows.map(toTask));
  }

  getTask(id: string, q: Queryable = this.db): Promise<TaskDto> {
    return one(q.query("select * from tasks where id = $1", [id]), toTask, "task", id);
  }

  /** Cancels the task; a running execution is told to stop on its next heartbeat. */
  async cancelTask(id: string): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      if (isTerminal(task.state)) throw new ConflictError(`task ${task.key} is already ${task.state}`);
      await q.query(
        "update executions set cancel_requested = true where task_id = $1 and status = any($2::text[])",
        [id, ACTIVE],
      );
      return changeTaskState(q, task, "cancelled");
    });
  }

  listExecutions(taskId: string): Promise<ExecutionDto[]> {
    return this.db
      .query("select * from executions where task_id = $1 order by attempt", [taskId])
      .then((rows) => rows.map(toExecution));
  }

  getExecution(id: string, q: Queryable = this.db): Promise<ExecutionDto> {
    return one(q.query("select * from executions where id = $1", [id]), toExecution, "execution", id);
  }

  // ---- runners (agent registry) -------------------------------------------

  /** Registers or re-registers (same name keeps the id, so sessions stay resumable). */
  async registerRunner(name: string, agents: AgentDescriptor[]): Promise<string> {
    return this.db.tx(async (q) => {
      const [row] = await q.query<{ id: string }>(
        `insert into runners (id, name, agents) values ($1, $2, $3)
         on conflict (name) do update set agents = excluded.agents, last_seen_at = now()
         returning id`,
        [randomUUID(), name, JSON.stringify(agents)],
      );
      await appendEvent(q, {
        type: "RunnerRegistered",
        payload: { runnerId: row!.id, name, agents: agents.map((a) => a.id) },
      });
      return row!.id;
    });
  }

  async listRunners(): Promise<RunnerDto[]> {
    const rows = await this.db.query(
      `select *, last_seen_at > now() - make_interval(secs => $1) as online from runners order by name`,
      [this.runnerOnlineSeconds],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      agents: r.agents as AgentDescriptor[],
      online: Boolean(r.online),
      registeredAt: iso(r.registered_at),
      lastSeenAt: iso(r.last_seen_at),
    }));
  }

  /**
   * Atomically hands the oldest READY task for one of the runner's agents to
   * the runner. Returns null when there is nothing to do.
   */
  async claim(runnerId: string): Promise<ClaimResponse | null> {
    return this.db.tx(async (q) => {
      const [runner] = await q.query<{ agents: AgentDescriptor[] }>(
        "update runners set last_seen_at = now() where id = $1 returning agents",
        [runnerId],
      );
      if (!runner) throw new NotFoundError("runner", runnerId);
      const agentIds = runner.agents.map((a) => a.id);
      if (!agentIds.length) return null;

      // Oldest READY task for our agents, in a project that is below its parallelism limit.
      const [taskRow] = await q.query(
        `select t.* from tasks t join projects p on p.id = t.project_id
         where t.state = 'READY' and t.agent = any($1::text[])
           and (p.max_parallel is null or (
             select count(*) from tasks w
             where w.project_id = t.project_id and w.state in ('ASSIGNED', 'RUNNING', 'VALIDATING')
           ) < p.max_parallel)
         order by t.created_at limit 1 for update of t skip locked`,
        [agentIds],
      );
      if (!taskRow) return null;
      const task = await changeTaskState(q, toTask(taskRow), "assigned", { runnerId });

      const [previous] = await q.query<{ id: string; attempt: number }>(
        "select id, attempt from executions where task_id = $1 order by attempt desc limit 1",
        [task.id],
      );
      const project = await this.getProject(task.projectId, q);
      const rework = previous ? await this.reworkContext(q, project, previous.id, previous.attempt) : undefined;
      const approvals = previous ? await this.approvalDecisions(q, previous.id) : [];
      const dependencies = await this.dependencyContext(q, task);
      const [lastSession] = await q.query<{ session_id: string; runner_id: string }>(
        `select session_id, runner_id from executions
         where task_id = $1 and session_id is not null order by attempt desc limit 1`,
        [task.id],
      );

      const executionToken = randomBytes(24).toString("base64url");
      const [execRow] = await q.query(
        `insert into executions (id, task_id, runner_id, attempt, status, token_hash, lease_expires_at)
         values ($1, $2, $3, $4, 'assigned', $5, now() + make_interval(secs => $6)) returning *`,
        [randomUUID(), task.id, runnerId, (previous?.attempt ?? 0) + 1, sha256(executionToken), this.leaseSeconds],
      );
      const execution = toExecution(execRow!);
      await appendEvent(q, {
        type: "ExecutionAssigned",
        projectId: task.projectId,
        taskId: task.id,
        executionId: execution.id,
        payload: {
          runnerId,
          attempt: execution.attempt,
          resumable: Boolean(lastSession),
          rework: rework?.kind ?? null,
          approvals: approvals.length,
        },
      });
      return {
        execution,
        task,
        project,
        executionToken,
        ...(lastSession && { resume: { sessionId: lastSession.session_id, runnerId: lastSession.runner_id } }),
        ...(rework && { rework }),
        ...(dependencies.length > 0 && { dependencies }),
        ...(approvals.length > 0 && { approvals }),
      };
    });
  }

  /**
   * Why the work of the given execution is being redone (spec §29): failed
   * validation, a rejected review, or a merge conflict with the base branch.
   */
  private async reworkContext(
    q: Queryable,
    project: ProjectDto,
    executionId: string,
    attempt: number,
  ): Promise<ReworkContext | undefined> {
    const [row] = await q.query<{ type: ArtifactType; content: any }>(
      `select type, content from artifacts
       where execution_id = $1 and type in ('validation_result', 'review_result', 'merge_result')
       order by created_at desc limit 1`,
      [executionId],
    );
    if (!row) return undefined;
    if (row.type === "validation_result" && !row.content.passed) {
      const report = row.content as ValidationReport;
      const failed = report.steps.filter((s) => !s.passed).map((s) => s.name);
      return { kind: "validation", attempt, reason: `validation failed: ${failed.join(", ")}`, validation: report };
    }
    if (row.type === "review_result" && row.content.decision === "reject") {
      return {
        kind: "review",
        attempt,
        reason: "the reviewer rejected the change",
        ...(row.content.comment && { comment: row.content.comment }),
      };
    }
    if (row.type === "merge_result" && row.content.status === "conflict") {
      return {
        kind: "merge_conflict",
        attempt,
        reason: `the branch conflicts with ${project.defaultBranch}`,
        baseBranch: project.defaultBranch,
      };
    }
    return undefined;
  }

  /** Latest handoff of every dependency, so the agent does not redo their analysis (spec §21). */
  private async dependencyContext(q: Queryable, task: TaskDto): Promise<DependencyContext[]> {
    if (!task.dependsOn.length) return [];
    const rows = await q.query(
      `select t.key, t.title,
         (select a.content from artifacts a where a.task_id = t.id and a.type = 'handoff'
          order by a.created_at desc limit 1) as handoff
       from tasks t where t.id = any($1::uuid[]) order by t.created_at`,
      [task.dependsOn],
    );
    return rows.map((r) => ({ key: r.key, title: r.title, handoff: r.handoff ?? null }));
  }

  /** Human decisions on the approval requests raised by the given execution. */
  private async approvalDecisions(q: Queryable, executionId: string): Promise<ApprovalDecision[]> {
    const rows = await q.query(
      `select tool, summary, status, comment from approvals
       where execution_id = $1 and status <> 'pending' order by created_at`,
      [executionId],
    );
    return rows.map((r) => ({ tool: r.tool, summary: r.summary, status: r.status, comment: r.comment ?? null }));
  }

  // ---- executions ---------------------------------------------------------

  private async lockExecution(q: Queryable, id: string, expected: ExecutionStatus[]) {
    const row = (await q.query("select * from executions where id = $1 for update", [id]))[0];
    if (!row) throw new NotFoundError("execution", id);
    const execution = toExecution(row);
    if (!expected.includes(execution.status)) {
      throw new ConflictError(`execution ${id} is ${execution.status}, expected ${expected.join("|")}`);
    }
    const task = await this.getTask(execution.taskId, q);
    return { execution, task, row };
  }

  async startExecution(id: string, workspace: string, branch: string): Promise<ExecutionDto> {
    return this.db.tx(async (q) => {
      const { task } = await this.lockExecution(q, id, ["assigned"]);
      const [row] = await q.query(
        `update executions set status = 'running', workspace = $2, branch = $3, started_at = now(),
           lease_expires_at = now() + make_interval(secs => $4) where id = $1 returning *`,
        [id, workspace, branch, this.leaseSeconds],
      );
      await appendEvent(q, {
        type: "ExecutionStarted",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { workspace, branch },
      });
      if (task.state === "ASSIGNED") await changeTaskState(q, task, "agent_started", { executionId: id });
      return toExecution(row!);
    });
  }

  /** Renews the lease. `cancel` tells the runner to stop (task cancelled, or execution no longer active). */
  async heartbeat(id: string): Promise<HeartbeatResponse> {
    return this.db.tx(async (q) => {
      const [row] = await q.query("select * from executions where id = $1 for update", [id]);
      if (!row) throw new NotFoundError("execution", id);
      if (!ACTIVE.includes(row.status)) {
        return { cancel: true, leaseExpiresAt: isoOrNull(row.lease_expires_at) ?? iso(new Date()) };
      }
      const [updated] = await q.query<{ lease_expires_at: Date; cancel_requested: boolean }>(
        `update executions set lease_expires_at = now() + make_interval(secs => $2)
         where id = $1 returning lease_expires_at, cancel_requested`,
        [id, this.leaseSeconds],
      );
      await q.query("update runners set last_seen_at = now() where id = $1", [row.runner_id]);
      return { cancel: updated!.cancel_requested, leaseExpiresAt: iso(updated!.lease_expires_at) };
    });
  }

  async appendAgentEvents(id: string, events: AgentEvent[]): Promise<void> {
    await this.db.tx(async (q) => {
      const { task } = await this.lockExecution(q, id, ["running"]);
      for (const event of events) {
        if (event.kind === "session_started") {
          await q.query("update executions set session_id = $2 where id = $1", [id, event.sessionId]);
        }
        await appendEvent(q, {
          type: "AgentEvent",
          projectId: task.projectId,
          taskId: task.id,
          executionId: id,
          payload: event as unknown as Record<string, unknown>,
        });
      }
    });
  }

  /** The agent finished. On success the execution stays leased while the runner validates. */
  async completeExecution(id: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    return this.db.tx(async (q) => {
      const { task, row: current } = await this.lockExecution(q, id, ["assigned", "running"]);
      const t = req.terminal;
      // Our own audit log is authoritative: an agent that reports success after
      // a policy denial still needs a human to look at it.
      const [policy] = await q.query<{ denials: number }>(
        `select count(*)::int as denials from events
         where execution_id = $1 and type = 'ToolCallChecked' and payload->>'decision' = 'deny'`,
        [id],
      );
      const denied = (policy?.denials ?? 0) > 0 || (t.kind === "completed" && t.deniedActions.length > 0);
      const status: ExecutionStatus = current.cancel_requested
        ? "cancelled"
        : t.kind === "completed" && denied
          ? "needs_approval"
          : t.kind === "completed" && t.success
            ? "validating"
            : "failed";
      const stillActive = status === "validating";

      const [row] = await q.query(
        `update executions set status = $2, exit_code = $3, result = $4,
           finished_at = case when $6 then null else now() end,
           lease_expires_at = case when $6 then now() + make_interval(secs => $7) else null end,
           session_id = coalesce($5, session_id) where id = $1 returning *`,
        [id, status, req.exitCode, JSON.stringify(t), t.sessionId || null, stillActive, this.leaseSeconds],
      );
      await appendEvent(q, {
        type: "AgentFinished",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { status, exitCode: req.exitCode },
      });
      if (t.kind === "completed" && status !== "cancelled") {
        await this.addArtifact(q, task, id, "handoff", toHandoff(t.result) as unknown as Record<string, unknown>);
      }

      // A task cancelled while running keeps its terminal state.
      if (!isTerminal(task.state) && status !== "cancelled") {
        const trigger: TaskTransitionTrigger =
          status === "validating" ? "agent_completed" : status === "needs_approval" ? "approval_requested" : "agent_failed";
        const next = await changeTaskState(q, task, trigger, { executionId: id });
        // Approvals decided while the agent was still running: no need to wait.
        await this.requeueIfApprovalsDecided(q, next);
      }
      return toExecution(row!);
    });
  }

  private async addArtifact(
    q: Queryable,
    task: TaskDto,
    executionId: string | null,
    type: ArtifactType,
    content: Record<string, unknown>,
  ): Promise<void> {
    const artifactId = randomUUID();
    await q.query(
      "insert into artifacts (id, project_id, task_id, execution_id, type, content) values ($1, $2, $3, $4, $5, $6)",
      [artifactId, task.projectId, task.id, executionId, type, JSON.stringify(content)],
    );
    await appendEvent(q, {
      type: "ArtifactCreated",
      projectId: task.projectId,
      taskId: task.id,
      executionId,
      payload: { artifactId, type },
    });
  }

  listArtifacts(taskId: string): Promise<ArtifactDto[]> {
    return this.db
      .query("select * from artifacts where task_id = $1 order by created_at", [taskId])
      .then((rows) => rows.map(toArtifact));
  }

  /**
   * Validation results from the runner (spec §28). Passing moves the task to
   * REVIEW and asks the runner to deliver; failing sends it to REWORK with the
   * results as context for the next attempt.
   */
  async recordValidation(id: string, report: ValidationReport): Promise<ValidationResponse> {
    return this.db.tx(async (q) => {
      const { task, row: current } = await this.lockExecution(q, id, ["validating"]);
      await this.addArtifact(q, task, id, "validation_result", report as unknown as Record<string, unknown>);
      await appendEvent(q, {
        type: report.passed ? "ValidationPassed" : "ValidationFailed",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: {
          steps: report.steps.map((s) => ({ name: s.name, passed: s.passed, exitCode: s.exitCode })),
          changedFiles: report.changedFiles.length,
        },
      });

      if (current.cancel_requested || isTerminal(task.state)) {
        await q.query(
          "update executions set status = 'cancelled', finished_at = now(), lease_expires_at = null where id = $1",
          [id],
        );
        return { deliver: false };
      }
      if (!report.passed) {
        await q.query(
          "update executions set status = 'failed', finished_at = now(), lease_expires_at = null where id = $1",
          [id],
        );
        await changeTaskState(q, task, "validation_failed", { executionId: id });
        return { deliver: false };
      }
      await q.query(
        "update executions set status = 'delivering', lease_expires_at = now() + make_interval(secs => $2) where id = $1",
        [id, this.leaseSeconds],
      );
      await changeTaskState(q, task, "validation_passed", { executionId: id });
      return { deliver: true };
    });
  }

  /**
   * The runner committed and pushed the task branch; open (or find) the pull
   * request. The provider call happens outside the transaction.
   */
  async recordDelivery(id: string, req: DeliveryRequest): Promise<DeliveryResponse> {
    const { task, project } = await this.db.tx(async (q) => {
      const { task } = await this.lockExecution(q, id, ["delivering"]);
      await q.query(
        "update executions set status = $2, finished_at = now(), lease_expires_at = null where id = $1",
        [id, req.error ? "failed" : "succeeded"],
      );
      await appendEvent(q, {
        type: req.error ? "DeliveryFailed" : req.commitSha ? "BranchPushed" : "NoChanges",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { branch: req.branch, commitSha: req.commitSha, changedFiles: req.changedFiles, error: req.error },
      });
      return { task, project: await this.getProject(task.projectId, q) };
    });
    if (req.error) return { pullRequest: null };

    const skip = async (reason: string) => {
      await appendEvent(this.db, {
        type: "PullRequestSkipped",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { reason },
      });
      return { pullRequest: null };
    };
    if (!req.commitSha) return skip("no file changes");
    if (!this.gitProvider) return skip("no git provider configured");

    const artifacts = await this.listArtifacts(task.id);
    const handoff = artifacts.filter((a) => a.type === "handoff" && a.executionId === id).at(-1)?.content as
      | Handoff
      | undefined;
    const validation = artifacts.filter((a) => a.type === "validation_result" && a.executionId === id).at(-1)
      ?.content as ValidationReport | undefined;

    let pullRequest;
    try {
      pullRequest = await this.gitProvider.openPullRequest({
        repoUrl: project.repoUrl,
        head: req.branch,
        base: project.defaultBranch,
        title: `${task.key}: ${task.title}`,
        body: pullRequestBody({ task, handoff, validation, changedFiles: req.changedFiles }),
      });
    } catch (err) {
      await appendEvent(this.db, {
        type: "PullRequestFailed",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { error: String(err) },
      });
      return { pullRequest: null };
    }
    if (!pullRequest) return skip("repository not handled by the git provider");

    await this.db.query("update tasks set pull_request_url = $2, pull_request_number = $3 where id = $1", [
      task.id,
      pullRequest.url,
      pullRequest.number,
    ]);
    await appendEvent(this.db, {
      type: "PullRequestOpened",
      projectId: task.projectId,
      taskId: task.id,
      executionId: id,
      payload: { ...pullRequest },
    });
    return { pullRequest };
  }

  /**
   * Policy check for one tool call, authorized by the execution token that
   * only the agent's policy hook holds. Every decision is audited.
   */
  async checkToolCall(id: string, token: string | undefined, call: ToolCheckRequest): Promise<PolicyVerdict> {
    const execution = (await this.db.query("select * from executions where id = $1", [id]))[0];
    if (!execution || !token || !execution.token_hash || !safeEqual(sha256(token), execution.token_hash)) {
      throw new UnauthorizedError("invalid execution token");
    }
    if (execution.status !== "running") {
      return { decision: "deny", risk: "HIGH", reason: `execution is ${execution.status}`, summary: call.tool };
    }
    const task = await this.getTask(execution.task_id);
    let verdict = evaluateToolCall(call, { workspace: execution.workspace });

    // HIGH risk goes through the approval gateway (spec §31-32); CRITICAL stays a hard deny.
    if (verdict.decision === "deny" && verdict.risk === "HIGH") {
      const key = approvalKey(call);
      const [approved] = await this.db.query(
        "select id from approvals where task_id = $1 and action_key = $2 and status = 'approved' limit 1",
        [task.id, key],
      );
      if (approved) {
        verdict = { ...verdict, decision: "allow", reason: `${verdict.reason} (approved by a human: ${approved.id})` };
      } else {
        const approvalId = await this.requestApproval(task, id, call, key, verdict);
        verdict = { ...verdict, reason: `${verdict.reason}; requires human approval (${approvalId})` };
      }
    }

    await appendEvent(this.db, {
      type: "ToolCallChecked",
      projectId: task.projectId,
      taskId: task.id,
      executionId: id,
      payload: { tool: call.tool, ...verdict },
    });
    return verdict;
  }

  /** Creates (or reuses) a pending approval request for this action. */
  private async requestApproval(
    task: TaskDto,
    executionId: string,
    call: ToolCheckRequest,
    key: string,
    verdict: PolicyVerdict,
  ): Promise<string> {
    return this.db.tx(async (q) => {
      const [pending] = await q.query(
        "select id from approvals where task_id = $1 and action_key = $2 and status = 'pending' limit 1",
        [task.id, key],
      );
      if (pending) return pending.id as string;
      const id = randomUUID();
      await q.query(
        `insert into approvals (id, project_id, task_id, execution_id, tool, input, action_key, summary, risk, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, task.projectId, task.id, executionId, call.tool, JSON.stringify(call.input ?? {}), key, verdict.summary, verdict.risk, verdict.reason],
      );
      await appendEvent(q, {
        type: "ApprovalRequested",
        projectId: task.projectId,
        taskId: task.id,
        executionId,
        payload: { approvalId: id, summary: verdict.summary, risk: verdict.risk, reason: verdict.reason },
      });
      return id;
    });
  }

  // ---- approvals, review, merge queue ---------------------------------------

  async listApprovals(filter: { status?: ApprovalDto["status"]; taskId?: string }): Promise<ApprovalDto[]> {
    const rows = await this.db.query(
      `select * from approvals where ($1::text is null or status = $1) and ($2::uuid is null or task_id = $2)
       order by created_at`,
      [filter.status ?? null, filter.taskId ?? null],
    );
    return rows.map(toApproval);
  }

  /**
   * Records a human decision. Once no approval of a waiting task is pending,
   * the task goes back to the queue; the next attempt resumes the session and
   * is told what was approved or rejected.
   */
  async decideApproval(id: string, status: "approved" | "rejected", comment?: string): Promise<ApprovalDto> {
    return this.db.tx(async (q) => {
      const row = (await q.query("select * from approvals where id = $1 for update", [id]))[0];
      if (!row) throw new NotFoundError("approval", id);
      if (row.status !== "pending") throw new ConflictError(`approval ${id} is already ${row.status}`);
      const [updated] = await q.query(
        "update approvals set status = $2, comment = $3, decided_at = now() where id = $1 returning *",
        [id, status, comment ?? null],
      );
      await appendEvent(q, {
        type: status === "approved" ? "ApprovalGranted" : "ApprovalRejected",
        projectId: row.project_id,
        taskId: row.task_id,
        executionId: row.execution_id,
        payload: { approvalId: id, summary: row.summary, comment: comment ?? null },
      });
      await this.requeueIfApprovalsDecided(q, await this.getTask(row.task_id, q));
      return toApproval(updated!);
    });
  }

  private async requeueIfApprovalsDecided(q: Queryable, task: TaskDto): Promise<void> {
    if (task.state !== "WAITING_FOR_HUMAN") return;
    const [counts] = await q.query<{ pending: number; decided: number }>(
      `select count(*) filter (where a.status = 'pending')::int as pending,
              count(*) filter (where a.status <> 'pending')::int as decided
       from approvals a
       where a.execution_id = (select id from executions where task_id = $1 order by attempt desc limit 1)`,
      [task.id],
    );
    if (counts && counts.pending === 0 && counts.decided > 0) {
      await changeTaskState(q, task, "unassigned", { reason: "approvals decided" });
    }
  }

  /** A human sends a WAITING_FOR_HUMAN or BLOCKED task back to the queue. */
  async retryTask(id: string): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      if (task.state === "WAITING_FOR_HUMAN") return changeTaskState(q, task, "unassigned", { reason: "retried by a human" });
      if (task.state === "BLOCKED") return changeTaskState(q, task, "unblocked", { reason: "retried by a human" });
      throw new ConflictError(`task ${task.key} is ${task.state}; only WAITING_FOR_HUMAN or BLOCKED tasks can be retried`);
    });
  }

  /** Human review of a delivered task (spec §30): approve queues the merge, reject sends it to rework. */
  async reviewTask(id: string, req: ReviewRequest): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      if (task.state !== "REVIEW") throw new ConflictError(`task ${task.key} is ${task.state}, not REVIEW`);
      const [last] = await q.query<{ id: string }>(
        "select id from executions where task_id = $1 order by attempt desc limit 1",
        [id],
      );
      await this.addArtifact(q, task, last?.id ?? null, "review_result", {
        decision: req.decision,
        comment: req.comment ?? null,
      });
      return changeTaskState(q, task, req.decision === "approve" ? "review_approved" : "review_rejected", {
        comment: req.comment ?? null,
      });
    });
  }

  /**
   * Merge queue (spec §33): merges APPROVED tasks one at a time per project,
   * oldest first. A conflict sends the task to REWORK (the runner merges the
   * base branch in and the agent resolves it); repeated other failures block it.
   * A completed task unlocks the tasks that depend on it.
   */
  async processMergeQueue(): Promise<MergeQueueResult> {
    const result: MergeQueueResult = { merged: 0, conflicts: 0, failed: 0 };
    // An in-flight MERGING task of a project goes first; otherwise its oldest APPROVED task.
    const next = await this.db.query(
      `select distinct on (project_id) * from tasks where state in ('MERGING', 'APPROVED')
       order by project_id, (state = 'MERGING') desc, updated_at`,
    );
    for (const row of next) {
      let task = toTask(row);
      const [last] = await this.db.query<{ id: string; branch: string | null }>(
        "select id, branch from executions where task_id = $1 order by attempt desc limit 1",
        [task.id],
      );
      if (task.state === "APPROVED") {
        try {
          task = await this.db.tx((q) => changeTaskState(q, task, "merge_started"));
        } catch (err) {
          if (err instanceof ConflictError) continue; // another worker took it
          throw err;
        }
      }

      if (!task.pullRequestNumber || !this.gitProvider) {
        // Nothing to merge (no changes, or no provider): the reviewed work is accepted as is.
        await this.finishMerge(task, last?.id ?? null, { status: "merged", sha: null }, "no pull request to merge");
        result.merged++;
        continue;
      }

      const project = await this.getProject(task.projectId);
      let merge: MergeResult;
      try {
        merge = await this.gitProvider.mergePullRequest({
          repoUrl: project.repoUrl,
          number: task.pullRequestNumber,
          head: last?.branch ?? `task/${task.key}`,
          commitTitle: `${task.key}: ${task.title} (#${task.pullRequestNumber})`,
        });
      } catch (err) {
        result.failed++;
        await this.recordMergeFailure(task, String(err));
        continue;
      }
      if (merge.status === "pending") continue; // retried on the next tick
      await this.finishMerge(task, last?.id ?? null, merge);
      if (merge.status === "merged") result.merged++;
      else result.conflicts++;
    }
    return result;
  }

  private async finishMerge(
    task: TaskDto,
    executionId: string | null,
    merge: Exclude<MergeResult, { status: "pending" }>,
    note?: string,
  ): Promise<void> {
    await this.db.tx(async (q) => {
      const current = await this.getTask(task.id, q);
      if (current.state !== "MERGING") return;
      await this.addArtifact(q, current, executionId, "merge_result", { ...merge, ...(note && { note }) });
      if (merge.status === "merged") {
        const completed = await changeTaskState(q, current, "merge_succeeded", {
          sha: merge.sha,
          ...(note && { note }),
        });
        await appendEvent(q, {
          type: "TaskMerged",
          projectId: task.projectId,
          taskId: task.id,
          payload: { pullRequest: task.pullRequestUrl, sha: merge.sha },
        });
        await this.unlockDependents(q, completed);
      } else {
        await changeTaskState(q, current, "merge_conflict", { message: merge.message });
      }
    });
  }

  private async recordMergeFailure(task: TaskDto, error: string): Promise<void> {
    await this.db.tx(async (q) => {
      await appendEvent(q, { type: "MergeFailed", projectId: task.projectId, taskId: task.id, payload: { error } });
      const [row] = await q.query<{ failures: number }>(
        `select count(*)::int as failures from events
         where task_id = $1 and type = 'MergeFailed'
           and seq > (select max(seq) from events where task_id = $1 and type = 'TaskStateChanged' and payload->>'to' = 'MERGING')`,
        [task.id],
      );
      if ((row?.failures ?? 0) >= MAX_MERGE_FAILURES) {
        const current = await this.getTask(task.id, q);
        if (current.state === "MERGING") await changeTaskState(q, current, "limit_exceeded", { error });
      }
    });
  }

  // ---- scheduler housekeeping ---------------------------------------------

  /**
   * Marks executions whose runner stopped heartbeating as lost, then requeues
   * RETRYING tasks (or blocks them once maxAttempts is used up).
   */
  async sweep(): Promise<SweepResult> {
    return this.db.tx(async (q) => {
      const result: SweepResult = { lost: 0, requeued: 0, blocked: 0 };

      const expired = await q.query(
        `select * from executions where status = any($1::text[]) and lease_expires_at < now()
         for update skip locked`,
        [ACTIVE],
      );
      for (const row of expired) {
        await q.query(
          "update executions set status = 'lost', finished_at = now(), lease_expires_at = null where id = $1",
          [row.id],
        );
        const task = await this.getTask(row.task_id, q);
        await appendEvent(q, {
          type: "ExecutionLost",
          projectId: task.projectId,
          taskId: task.id,
          executionId: row.id,
          payload: { runnerId: row.runner_id, attempt: row.attempt, phase: row.status },
        });
        if (["ASSIGNED", "RUNNING", "VALIDATING"].includes(task.state)) {
          await changeTaskState(q, task, "agent_failed", { executionId: row.id, reason: "runner lease expired" });
        } else if (row.status === "delivering") {
          // Validated work may or may not have been pushed; leave the task in
          // REVIEW for a human instead of redoing validated work.
          await appendEvent(q, {
            type: "DeliveryLost",
            projectId: task.projectId,
            taskId: task.id,
            executionId: row.id,
            payload: { branch: row.branch },
          });
        }
        result.lost++;
      }

      // Failed attempts (RETRYING) and failed validation (REWORK) go back to the
      // queue until maxAttempts is used up.
      const retrying = await q.query(
        `select t.*, (select count(*) from executions e where e.task_id = t.id)::int as attempts
         from tasks t where t.state in ('RETRYING', 'REWORK') for update skip locked`,
      );
      for (const row of retrying) {
        const task = toTask(row);
        if (row.attempts < task.maxAttempts) {
          await changeTaskState(q, task, "unassigned", { attempts: row.attempts });
          result.requeued++;
        } else {
          await changeTaskState(q, task, "limit_exceeded", { attempts: row.attempts });
          result.blocked++;
        }
      }
      return result;
    });
  }

  // ---- events -------------------------------------------------------------

  async listEvents(
    filter: { projectId?: string; taskId?: string; executionId?: string },
    after = 0,
    limit = 200,
  ): Promise<EventDto[]> {
    const [column, value] = filter.executionId
      ? ["execution_id", filter.executionId]
      : filter.taskId
        ? ["task_id", filter.taskId]
        : ["project_id", filter.projectId];
    const rows = await this.db.query(
      `select * from events where ${column} = $1 and seq > $2 order by seq limit $3`,
      [value, after, limit],
    );
    return rows.map(toEvent);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
