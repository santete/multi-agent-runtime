import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type ClaimResponse,
  type CompleteExecutionRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type EventDto,
  type ExecutionDto,
  type ExecutionStatus,
  type ProjectDto,
  type TaskDto,
  type TaskState,
  type TaskTransitionTrigger,
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

type Row = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

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
  const rows = await q.query(
    "update tasks set state = $1, version = version + 1, updated_at = now() where id = $2 and version = $3 returning *",
    [to, task.id, task.version],
  );
  const [row] = rows;
  if (!row) throw new ConflictError(`task ${task.key} was modified concurrently`);
  await appendEvent(q, {
    type: "TaskStateChanged",
    projectId: task.projectId,
    taskId: task.id,
    payload: { from: task.state, to, trigger, ...payload },
  });
  return toTask(row);
}

export class Store {
  constructor(private readonly db: Db) {}

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
      const [p] = await q.query(
        "update projects set task_seq = task_seq + 1 where id = $1 returning key, task_seq",
        [projectId],
      );
      if (!p) throw new NotFoundError("project", projectId);
      const key = `${p.key}-${p.task_seq}`;
      const [row] = await q.query(
        `insert into tasks (id, project_id, key, title, objective, agent, state)
         values ($1, $2, $3, $4, $5, $6, 'CREATED') returning *`,
        [randomUUID(), projectId, key, req.title, req.objective, req.agent],
      );
      const task = toTask(row!);
      await appendEvent(q, {
        type: "TaskCreated",
        projectId,
        taskId: task.id,
        payload: { key, title: task.title, agent: task.agent },
      });
      // M1 has no dependencies yet, so every new task is immediately ready.
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

  async cancelTask(id: string): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      if (isTerminal(task.state)) throw new ConflictError(`task ${task.key} is already ${task.state}`);
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

  // ---- runners ------------------------------------------------------------

  async registerRunner(name: string, agents: string[]): Promise<string> {
    const id = randomUUID();
    await this.db.tx(async (q) => {
      await q.query("insert into runners (id, name, agents) values ($1, $2, $3)", [id, name, JSON.stringify(agents)]);
      await appendEvent(q, { type: "RunnerRegistered", payload: { runnerId: id, name, agents } });
    });
    return id;
  }

  /**
   * Atomically hands the oldest READY task for one of the runner's agents to
   * the runner. Returns null when there is nothing to do.
   */
  async claim(runnerId: string): Promise<ClaimResponse | null> {
    return this.db.tx(async (q) => {
      const [runner] = await q.query<{ agents: string[] }>(
        "update runners set last_seen_at = now() where id = $1 returning agents",
        [runnerId],
      );
      if (!runner) throw new NotFoundError("runner", runnerId);
      const { agents } = runner;
      if (!agents.length) return null;

      const [taskRow] = await q.query(
        `select * from tasks where state = 'READY' and agent = any($1::text[])
         order by created_at limit 1 for update skip locked`,
        [agents],
      );
      if (!taskRow) return null;
      const task = await changeTaskState(q, toTask(taskRow), "assigned", { runnerId });

      const [next] = await q.query<{ attempt: number }>(
        "select coalesce(max(attempt), 0) + 1 as attempt from executions where task_id = $1",
        [task.id],
      );
      const attempt = next!.attempt;
      const [execRow] = await q.query(
        `insert into executions (id, task_id, runner_id, attempt, status)
         values ($1, $2, $3, $4, 'assigned') returning *`,
        [randomUUID(), task.id, runnerId, attempt],
      );
      const execution = toExecution(execRow!);
      await appendEvent(q, {
        type: "ExecutionAssigned",
        projectId: task.projectId,
        taskId: task.id,
        executionId: execution.id,
        payload: { runnerId, attempt },
      });
      return { execution, task, project: await this.getProject(task.projectId, q) };
    });
  }

  // ---- executions ---------------------------------------------------------

  private async lockExecution(q: Queryable, id: string, expected: ExecutionStatus[]) {
    const execution = await one(
      q.query("select * from executions where id = $1 for update", [id]),
      toExecution,
      "execution",
      id,
    );
    if (!expected.includes(execution.status)) {
      throw new ConflictError(`execution ${id} is ${execution.status}, expected ${expected.join("|")}`);
    }
    const task = await this.getTask(execution.taskId, q);
    return { execution, task };
  }

  async startExecution(id: string, workspace: string, branch: string): Promise<ExecutionDto> {
    return this.db.tx(async (q) => {
      const { task } = await this.lockExecution(q, id, ["assigned"]);
      const [row] = await q.query(
        "update executions set status = 'running', workspace = $2, branch = $3, started_at = now() where id = $1 returning *",
        [id, workspace, branch],
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
      const { task } = await this.lockExecution(q, id, ["assigned", "running"]);
      const t = req.terminal;
      const status: ExecutionStatus =
        t.kind === "completed" && t.success
          ? "succeeded"
          : t.kind === "completed" && t.deniedActions.length > 0
            ? "needs_approval"
            : "failed";
      const sessionId = t.sessionId || null;

      const [row] = await q.query(
        `update executions set status = $2, exit_code = $3, result = $4, finished_at = now(),
           session_id = coalesce($5, session_id) where id = $1 returning *`,
        [id, status, req.exitCode, JSON.stringify(t), sessionId],
      );
      await appendEvent(q, {
        type: "ExecutionFinished",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { status, exitCode: req.exitCode },
      });

      // A task cancelled while running keeps its terminal state.
      if (!isTerminal(task.state)) {
        const trigger: TaskTransitionTrigger =
          status === "succeeded" ? "agent_completed" : status === "needs_approval" ? "approval_requested" : "agent_failed";
        await changeTaskState(q, task, trigger, { executionId: id });
      }
      return toExecution(row!);
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
