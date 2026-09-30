import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AgentDescriptor,
  type AgentEvent,
  type ClaimResponse,
  type CompleteExecutionRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type EventDto,
  type ExecutionDto,
  type ExecutionStatus,
  type HeartbeatResponse,
  type PolicyVerdict,
  type ProjectDto,
  type RunnerDto,
  type TaskDto,
  type TaskState,
  type TaskTransitionTrigger,
  type ToolCheckRequest,
  evaluateToolCall,
  isTerminal,
  transition,
} from "@mar/core";
import type { Db, Queryable } from "./db.js";

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
}

type Row = Record<string, any>;

const ACTIVE: ExecutionStatus[] = ["assigned", "running"];

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const toProject = (r: Row): ProjectDto => ({
  id: r.id,
  key: r.key,
  name: r.name,
  repoUrl: r.repo_url,
  defaultBranch: r.default_branch,
  createdAt: iso(r.created_at),
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

export interface SweepResult {
  lost: number;
  requeued: number;
  blocked: number;
}

export class Store {
  private readonly leaseSeconds: number;
  private readonly runnerOnlineSeconds: number;

  constructor(
    private readonly db: Db,
    options: StoreOptions = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.runnerOnlineSeconds = options.runnerOnlineSeconds ?? 30;
  }

  // ---- projects -----------------------------------------------------------

  async createProject(req: CreateProjectRequest): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const existing = await q.query("select 1 from projects where key = $1", [req.key]);
      if (existing.length) throw new ConflictError(`project key already exists: ${req.key}`);
      const [row] = await q.query(
        "insert into projects (id, key, name, repo_url, default_branch) values ($1, $2, $3, $4, $5) returning *",
        [randomUUID(), req.key, req.name, req.repoUrl, req.defaultBranch ?? "main"],
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

  // ---- tasks --------------------------------------------------------------

  async createTask(projectId: string, req: CreateTaskRequest): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const [p] = await q.query<{ key: string; task_seq: number }>(
        "update projects set task_seq = task_seq + 1 where id = $1 returning key, task_seq",
        [projectId],
      );
      if (!p) throw new NotFoundError("project", projectId);
      const key = `${p.key}-${p.task_seq}`;
      const [row] = await q.query(
        `insert into tasks (id, project_id, key, title, objective, agent, state, max_attempts)
         values ($1, $2, $3, $4, $5, $6, 'CREATED', $7) returning *`,
        [randomUUID(), projectId, key, req.title, req.objective, req.agent, req.maxAttempts ?? 3],
      );
      const task = toTask(row!);
      await appendEvent(q, {
        type: "TaskCreated",
        projectId,
        taskId: task.id,
        payload: { key, title: task.title, agent: task.agent },
      });
      // No dependencies yet (M4), so every new task is immediately ready.
      return changeTaskState(q, task, "dependencies_satisfied");
    });
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

      const [taskRow] = await q.query(
        `select * from tasks where state = 'READY' and agent = any($1::text[])
         order by created_at limit 1 for update skip locked`,
        [agentIds],
      );
      if (!taskRow) return null;
      const task = await changeTaskState(q, toTask(taskRow), "assigned", { runnerId });

      const [previous] = await q.query<{ attempt: number; session_id: string | null; runner_id: string }>(
        "select attempt, session_id, runner_id from executions where task_id = $1 order by attempt desc limit 1",
        [task.id],
      );
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
        payload: { runnerId, attempt: execution.attempt, resumable: Boolean(lastSession) },
      });
      return {
        execution,
        task,
        project: await this.getProject(task.projectId, q),
        executionToken,
        ...(lastSession && { resume: { sessionId: lastSession.session_id, runnerId: lastSession.runner_id } }),
      };
    });
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

  async completeExecution(id: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    return this.db.tx(async (q) => {
      const { task, row: current } = await this.lockExecution(q, id, ACTIVE);
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
            ? "succeeded"
            : "failed";

      const [row] = await q.query(
        `update executions set status = $2, exit_code = $3, result = $4, finished_at = now(), lease_expires_at = null,
           session_id = coalesce($5, session_id) where id = $1 returning *`,
        [id, status, req.exitCode, JSON.stringify(t), t.sessionId || null],
      );
      await appendEvent(q, {
        type: "ExecutionFinished",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { status, exitCode: req.exitCode },
      });

      // A task cancelled while running keeps its terminal state.
      if (!isTerminal(task.state) && status !== "cancelled") {
        const trigger: TaskTransitionTrigger =
          status === "succeeded" ? "agent_completed" : status === "needs_approval" ? "approval_requested" : "agent_failed";
        await changeTaskState(q, task, trigger, { executionId: id });
      }
      return toExecution(row!);
    });
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
    const verdict = evaluateToolCall(call, { workspace: execution.workspace });
    const task = await this.getTask(execution.task_id);
    await appendEvent(this.db, {
      type: "ToolCallChecked",
      projectId: task.projectId,
      taskId: task.id,
      executionId: id,
      payload: { tool: call.tool, ...verdict },
    });
    return verdict;
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
          payload: { runnerId: row.runner_id, attempt: row.attempt },
        });
        if (task.state === "ASSIGNED" || task.state === "RUNNING") {
          await changeTaskState(q, task, "agent_failed", { executionId: row.id, reason: "runner lease expired" });
        }
        result.lost++;
      }

      const retrying = await q.query(
        `select t.*, (select count(*) from executions e where e.task_id = t.id)::int as attempts
         from tasks t where t.state = 'RETRYING' for update skip locked`,
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
