import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AgentDescriptor,
  type AgentStats,
  type ApprovePlanRequest,
  type CreatePlanRequest,
  type CreateKnowledgeRequest,
  type KnowledgeContext,
  type KnowledgeDto,
  type KnowledgeNote,
  type KnowledgeStatus,
  type MergePolicy,
  type UpdateKnowledgeRequest,
  type PlanDto,
  type PlanningContext,
  type PlanProposal,
  type RevisePlanRequest,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalDto,
  type ArtifactDto,
  type ArtifactType,
  type CheckRun,
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
  type ReviewPolicy,
  type ReviewRequest,
  type ReviewResult,
  type ReviewTarget,
  type RunnerDto,
  type TaskDto,
  type TaskGraph,
  type TaskState,
  type TaskTransitionTrigger,
  type ToolCheckRequest,
  type ValidationReport,
  type ValidationResponse,
  type ValidationSandbox,
  type ValidationStep,
  ACTIVE_EXECUTION_STATUSES,
  approvalKey,
  checkPlan,
  KNOWLEDGE_KINDS,
  sameKnowledge,
  chooseAgent,
  isAgentUnavailable,
  isCiConfigPath,
  evaluateToolCall,
  isTerminal,
  formatReview,
  toHandoff,
  toReviewResult,
  transition,
} from "@mar/core";
import { meter, withSpan } from "@mar/telemetry";
import { type Actor, hasRole } from "./auth.js";
import type { Db, Queryable } from "./db.js";
import type { GitProvider, MergeResult, PullRequestStatus } from "./git-provider.js";
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

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
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
  /**
   * With waitForChecks, how long the merge queue waits for a pull request to
   * report any CI check before it merges without CI.
   */
  ciGraceSeconds?: number;
}

type Row = Record<string, any>;

const ACTIVE = [...ACTIVE_EXECUTION_STATUSES];
/** How much accepted knowledge (characters) an agent gets with its task. */
const KNOWLEDGE_CONTEXT_CHARS = 40_000;
/** Agent value of a task the scheduler still has to route. */
const AUTO = "auto";

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
  reviewAgents: r.review_agents ?? [],
  autoApproveOnAgentReview: Boolean(r.auto_approve_on_agent_review),
  routingPolicy: r.routing_policy ?? "balanced",
  revalidateOnBaseChange: r.revalidate_on_base_change ?? true,
  waitForChecks: Boolean(r.wait_for_checks),
  validationSandbox: r.validation_sandbox ?? null,
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
  decidedBy: r.decided_by ?? null,
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
  routing: r.routing ?? "fixed",
  requires: r.requires ?? [],
  fallbackAgents: r.fallback_agents ?? [],
  excludedAgents: r.excluded_agents ?? [],
  kind: r.kind ?? "work",
  reviewOf: r.review_of ?? null,
  planId: r.plan_id ?? null,
  dependsOn: r.depends_on ?? [],
  pullRequestUrl: r.pull_request_url ?? null,
  pullRequestNumber: r.pull_request_number ?? null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const KNOWLEDGE_SELECT = `select k.*, t.key as source_task_key from knowledge k left join tasks t on t.id = k.source_task_id`;

const toKnowledge = (r: Row): KnowledgeDto => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  status: r.status,
  sourceTaskId: r.source_task_id ?? null,
  sourceTaskKey: r.source_task_key ?? null,
  sourceAgent: r.source_agent ?? null,
  createdBy: r.created_by ?? null,
  decidedBy: r.decided_by ?? null,
  supersededBy: r.superseded_by ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Plans with their (latest) planner task; "failed" is derived from that task. */
const PLAN_SELECT = `select p.*, t.id as planner_task_id, t.key as planner_task_key, t.agent as planner_agent,
    t.state as planner_state
  from plans p left join lateral (
    select * from tasks t where t.plan_id = p.id and t.kind = 'plan' order by t.created_at desc limit 1
  ) t on true`;

const toPlan = (r: Row): PlanDto => ({
  id: r.id,
  projectId: r.project_id,
  goal: r.goal,
  status: r.status === "planning" && ["BLOCKED", "CANCELLED"].includes(r.planner_state) ? "failed" : r.status,
  plannerTaskId: r.planner_task_id ?? null,
  plannerTaskKey: r.planner_task_key ?? null,
  plannerAgent: r.planner_agent ?? null,
  proposal: r.proposal ?? null,
  createdTasks: r.created_tasks ?? [],
  feedback: r.feedback ?? null,
  previousPlanId: r.previous_plan_id ?? null,
  createdBy: r.created_by ?? null,
  decidedBy: r.decided_by ?? null,
  comment: r.comment ?? null,
  createdAt: iso(r.created_at),
  decidedAt: r.decided_at ? iso(r.decided_at) : null,
});

const toExecution = (r: Row): ExecutionDto => ({
  id: r.id,
  taskId: r.task_id,
  runnerId: r.runner_id,
  attempt: r.attempt,
  agent: r.agent ?? null,
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
  taskKey: r.task_key ?? null,
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
  meter().createCounter("mar.task.transitions", { description: "Task state changes" }).add(1, { from: task.state, to, trigger });
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
  /** Sent back to re-validate on the moved base branch. */
  revalidating: number;
  /** Waiting for CI checks. */
  waiting: number;
  /** Sent back to rework because CI failed. */
  ciFailed: number;
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
  private readonly ciGraceSeconds: number;

  constructor(
    private readonly db: Db,
    options: StoreOptions = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.runnerOnlineSeconds = options.runnerOnlineSeconds ?? 30;
    this.gitProvider = options.gitProvider;
    this.ciGraceSeconds = options.ciGraceSeconds ?? 120;
  }

  // ---- projects -----------------------------------------------------------

  async createProject(req: CreateProjectRequest): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const existing = await q.query("select 1 from projects where key = $1", [req.key]);
      if (existing.length) throw new ConflictError(`project key already exists: ${req.key}`);
      const [row] = await q.query(
        `insert into projects (id, key, name, repo_url, default_branch, validation, max_parallel,
           review_agents, auto_approve_on_agent_review, routing_policy, revalidate_on_base_change, wait_for_checks,
           validation_sandbox)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
        [
          randomUUID(),
          req.key,
          req.name,
          req.repoUrl,
          req.defaultBranch ?? "main",
          JSON.stringify(req.validation ?? []),
          req.maxParallel ?? null,
          JSON.stringify(req.reviewAgents ?? []),
          req.autoApproveOnAgentReview ?? false,
          req.routingPolicy ?? "balanced",
          req.revalidateOnBaseChange ?? true,
          req.waitForChecks ?? false,
          req.validationSandbox ? JSON.stringify(req.validationSandbox) : null,
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

  async setReviewPolicy(id: string, policy: ReviewPolicy): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const project = await one(
        q.query(
          "update projects set review_agents = $2, auto_approve_on_agent_review = $3 where id = $1 returning *",
          [id, JSON.stringify(policy.reviewAgents), policy.autoApproveOnAgentReview],
        ),
        toProject,
        "project",
        id,
      );
      await appendEvent(q, { type: "ProjectReviewPolicyChanged", projectId: id, payload: { ...policy } });
      return project;
    });
  }

  async setMergePolicy(id: string, policy: MergePolicy): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const project = await one(
        q.query(
          "update projects set revalidate_on_base_change = $2, wait_for_checks = $3 where id = $1 returning *",
          [id, policy.revalidateOnBaseChange, policy.waitForChecks],
        ),
        toProject,
        "project",
        id,
      );
      await appendEvent(q, { type: "ProjectMergePolicyChanged", projectId: id, payload: { ...policy } });
      return project;
    });
  }

  async setValidationSandbox(id: string, sandbox: ValidationSandbox | null): Promise<ProjectDto> {
    return this.db.tx(async (q) => {
      const project = await one(
        q.query("update projects set validation_sandbox = $2 where id = $1 returning *", [id, sandbox ? JSON.stringify(sandbox) : null]),
        toProject,
        "project",
        id,
      );
      await appendEvent(q, { type: "ProjectValidationSandboxChanged", projectId: id, payload: { sandbox } });
      return project;
    });
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

  async createTask(projectId: string, req: CreateTaskRequest, actor?: string): Promise<TaskDto> {
    return this.db.tx((q) => this.insertTask(q, projectId, req, actor));
  }

  private async insertTask(
    q: Queryable,
    projectId: string,
    req: CreateTaskRequest,
    actor?: string,
    planId: string | null = null,
    kind: "work" | "plan" = "work",
  ): Promise<TaskDto> {
    const [p] = await q.query<{ key: string; task_seq: number }>(
      "update projects set task_seq = task_seq + 1 where id = $1 returning key, task_seq",
      [projectId],
    );
    if (!p) throw new NotFoundError("project", projectId);
    const key = `${p.key}-${p.task_seq}`;
    const deps = await this.resolveDependencies(q, projectId, req.dependsOn ?? []);
    const [row] = await q.query(
      `insert into tasks (id, project_id, key, title, objective, agent, state, max_attempts, depends_on,
         routing, requires, fallback_agents, plan_id, kind)
       values ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8::uuid[], $9, $10, $11, $12, $13) returning *`,
      [
        randomUUID(),
        projectId,
        key,
        req.title,
        req.objective,
        req.agent,
        req.maxAttempts ?? 3,
        deps.map((d) => d.id),
        req.agent === AUTO ? "auto" : "fixed",
        JSON.stringify(req.requires ?? []),
        JSON.stringify(req.fallbackAgents ?? []),
        planId,
        kind,
      ],
    );
    const task = toTask(row!);
    await appendEvent(q, {
      type: "TaskCreated",
      projectId,
      taskId: task.id,
      payload: {
        key,
        title: task.title,
        agent: task.agent,
        requires: task.requires,
        dependsOn: deps.map((d) => d.key),
        ...(planId && { planId }),
        actor: actor ?? null,
      },
    });
    if (deps.every((d) => d.state === "COMPLETED")) return changeTaskState(q, task, "dependencies_satisfied");
    return task; // stays CREATED (waiting for dependencies) until they are merged
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

  // ---- plans (assisted planning, spec §24) ----------------------------------

  /** Asks a planner agent to break the goal into a task DAG for a human to approve. */
  async createPlan(projectId: string, req: CreatePlanRequest, actor?: string): Promise<PlanDto> {
    return this.db.tx(async (q) => this.getPlan(await this.insertPlan(q, projectId, req, actor), q));
  }

  private async insertPlan(
    q: Queryable,
    projectId: string,
    req: CreatePlanRequest,
    actor?: string,
    previous?: { id: string; feedback: string },
  ): Promise<string> {
    await this.getProject(projectId, q);
    const id = randomUUID();
    await q.query(
      `insert into plans (id, project_id, goal, previous_plan_id, feedback, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, projectId, req.goal, previous?.id ?? null, previous?.feedback ?? null, actor ?? null],
    );
    const title = req.goal.replace(/\s+/g, " ").trim();
    const task = await this.insertTask(
      q,
      projectId,
      { title: `Plan: ${title.length > 80 ? `${title.slice(0, 79)}…` : title}`, objective: req.goal, agent: req.agent, maxAttempts: 2 },
      actor,
      id,
      "plan",
    );
    await appendEvent(q, {
      type: "PlanRequested",
      projectId,
      taskId: task.id,
      payload: { planId: id, goal: title.slice(0, 200), agent: req.agent, revises: previous?.id ?? null, actor: actor ?? null },
    });
    return id;
  }

  listPlans(projectId: string): Promise<PlanDto[]> {
    return this.db.query(`${PLAN_SELECT} where p.project_id = $1 order by p.created_at desc`, [projectId]).then((rows) => rows.map(toPlan));
  }

  getPlan(id: string, q: Queryable = this.db): Promise<PlanDto> {
    return one(q.query(`${PLAN_SELECT} where p.id = $1`, [id]), toPlan, "plan", id);
  }

  private async lockPlan(q: Queryable, id: string): Promise<PlanDto> {
    await one(q.query("select id from plans where id = $1 for update", [id]), (r) => r, "plan", id);
    return this.getPlan(id, q);
  }

  /**
   * Creates the planned tasks (as proposed, or as edited by the reviewer) in
   * dependency order; each becomes READY once its dependencies are merged.
   */
  async approvePlan(id: string, req: ApprovePlanRequest, actor?: string): Promise<PlanDto> {
    return this.db.tx(async (q) => {
      const plan = await this.lockPlan(q, id);
      if (plan.status !== "proposed") throw new ConflictError(`plan is ${plan.status}; only a proposed plan can be approved`);
      const check = checkPlan(req.tasks ? { summary: plan.proposal?.summary ?? "", tasks: req.tasks } : plan.proposal);
      if (!check.ok) throw new ConflictError(`invalid plan: ${check.error}`);
      const created: PlanDto["createdTasks"] = [];
      for (const t of check.plan.tasks) {
        const task = await this.insertTask(
          q,
          plan.projectId,
          {
            title: t.title,
            objective: t.objective,
            agent: t.agent ?? AUTO,
            requires: t.requires,
            dependsOn: t.dependsOn.map((d) => created.find((c) => c.ref === d)?.taskId ?? d),
          },
          actor,
          plan.id,
        );
        created.push({ ref: t.ref, taskId: task.id, key: task.key });
      }
      if (plan.plannerTaskId) await this.acceptTaskKnowledge(q, plan.plannerTaskId, actor ?? "platform");
      await q.query(
        `update plans set status = 'approved', proposal = $2, created_tasks = $3, decided_by = $4, comment = $5,
           decided_at = now() where id = $1`,
        [id, JSON.stringify(check.plan), JSON.stringify(created), actor ?? null, req.comment ?? null],
      );
      await appendEvent(q, {
        type: "PlanApproved",
        projectId: plan.projectId,
        payload: { planId: id, tasks: created.map((c) => c.key), edited: Boolean(req.tasks), actor: actor ?? null },
      });
      return this.getPlan(id, q);
    });
  }

  /** Rejects the plan; a planner still working on it is cancelled. */
  async rejectPlan(id: string, comment: string | undefined, actor?: string): Promise<PlanDto> {
    return this.db.tx(async (q) => {
      const plan = await this.lockPlan(q, id);
      if (!["planning", "proposed", "failed"].includes(plan.status)) throw new ConflictError(`plan is already ${plan.status}`);
      await this.closePlan(q, plan, "rejected", comment, actor);
      return this.getPlan(id, q);
    });
  }

  /** Sends the proposal back to a planner with the reviewer's feedback, as a new plan. */
  async revisePlan(id: string, req: RevisePlanRequest, actor?: string): Promise<PlanDto> {
    return this.db.tx(async (q) => {
      const plan = await this.lockPlan(q, id);
      if (plan.status !== "proposed") throw new ConflictError(`plan is ${plan.status}; only a proposed plan can be revised`);
      await this.closePlan(q, plan, "revised", req.feedback, actor);
      const planner = plan.plannerTaskId ? await this.getTask(plan.plannerTaskId, q) : undefined;
      const agent = !planner || planner.routing === "auto" ? AUTO : planner.agent;
      return this.getPlan(await this.insertPlan(q, plan.projectId, { goal: plan.goal, agent }, actor, { id, feedback: req.feedback }), q);
    });
  }

  private async closePlan(q: Queryable, plan: PlanDto, status: "rejected" | "revised", comment: string | undefined, actor?: string) {
    await q.query("update plans set status = $2, comment = $3, decided_by = $4, decided_at = now() where id = $1", [
      plan.id,
      status,
      comment ?? null,
      actor ?? null,
    ]);
    if (plan.plannerTaskId) {
      const planner = await this.getTask(plan.plannerTaskId, q);
      if (!isTerminal(planner.state)) {
        await q.query("update executions set cancel_requested = true where task_id = $1 and status = any($2::text[])", [
          planner.id,
          ACTIVE,
        ]);
        await changeTaskState(q, planner, "cancelled", { actor: actor ?? null });
      }
    }
    await appendEvent(q, {
      type: status === "rejected" ? "PlanRejected" : "PlanRevisionRequested",
      projectId: plan.projectId,
      payload: { planId: plan.id, comment: comment ?? null, actor: actor ?? null },
    });
  }

  /** What the planner agent needs: the goal, the agents it can plan for and the open work. */
  private async planningContext(q: Queryable, planId: string, project: ProjectDto): Promise<PlanningContext> {
    const plan = await this.getPlan(planId, q);
    const previous = plan.previousPlanId ? await this.getPlan(plan.previousPlanId, q) : undefined;
    const open = await q.query(
      `select key, title, state from tasks where project_id = $1 and kind = 'work'
         and state not in ('COMPLETED', 'CANCELLED') order by created_at limit 50`,
      [project.id],
    );
    return {
      planId,
      goal: plan.goal,
      baseBranch: project.defaultBranch,
      agents: await this.onlineAgents(q),
      openTasks: open.map((r) => ({ key: r.key, title: r.title, state: r.state })),
      ...(previous?.proposal && { previous: { proposal: previous.proposal, feedback: plan.feedback ?? "" } }),
    };
  }

  private async onlineAgents(q: Queryable): Promise<PlanningContext["agents"]> {
    const rows = await q.query<{ agents: AgentDescriptor[] }>(
      "select agents from runners where last_seen_at > now() - make_interval(secs => $1) order by name",
      [this.runnerOnlineSeconds],
    );
    const agents = new Map<string, PlanningContext["agents"][number]>();
    for (const a of rows.flatMap((r) => r.agents)) {
      if (!agents.has(a.id)) agents.set(a.id, { id: a.id, skills: a.skills ?? [], cost: a.cost ?? null });
    }
    return [...agents.values()];
  }

  /** Records the planner's proposal for a human to decide on. */
  private async finishPlan(
    q: Queryable,
    task: TaskDto,
    id: string,
    req: CompleteExecutionRequest,
    proposal: PlanProposal,
  ): Promise<ExecutionDto> {
    // Agents the planner made up are left to the scheduler instead.
    const known = new Set((await this.onlineAgents(q)).map((a) => a.id));
    const plan = { ...proposal, tasks: proposal.tasks.map((t) => (t.agent && !known.has(t.agent) ? { ...t, agent: null } : t)) };
    const execution = await this.finishExecution(q, task, id, req, "succeeded", { tasks: plan.tasks.length });
    await this.proposeKnowledge(q, task, plan.knowledge);
    await this.addArtifact(q, task, id, "plan_proposal", plan as unknown as Record<string, unknown>);
    if (!isTerminal(task.state)) await changeTaskState(q, task, "review_submitted", { tasks: plan.tasks.length });
    const [updated] = await q.query(
      "update plans set status = 'proposed', proposal = $2 where id = $1 and status = 'planning' returning id",
      [task.planId, JSON.stringify(plan)],
    );
    if (updated) {
      await appendEvent(q, {
        type: "PlanProposed",
        projectId: task.projectId,
        taskId: task.id,
        payload: { planId: task.planId, tasks: plan.tasks.length, summary: plan.summary.slice(0, 500) },
      });
    }
    return execution;
  }

  // ---- knowledge base (spec §20, §35) --------------------------------------

  listKnowledge(projectId: string, status?: KnowledgeStatus): Promise<KnowledgeDto[]> {
    return this.db
      .query(
        `${KNOWLEDGE_SELECT} where k.project_id = $1 and ($2::text is null or k.status = $2)
         order by array_position($3::text[], k.kind), k.updated_at desc`,
        [projectId, status ?? null, [...KNOWLEDGE_KINDS]],
      )
      .then((rows) => rows.map(toKnowledge));
  }

  getKnowledge(id: string, q: Queryable = this.db): Promise<KnowledgeDto> {
    return one(q.query(`${KNOWLEDGE_SELECT} where k.id = $1`, [id]), toKnowledge, "knowledge", id);
  }

  /** A person writes knowledge down: trusted right away. */
  async createKnowledge(projectId: string, req: CreateKnowledgeRequest, actor?: string): Promise<KnowledgeDto> {
    return this.db.tx(async (q) => {
      await this.getProject(projectId, q);
      const id = randomUUID();
      await q.query(
        `insert into knowledge (id, project_id, kind, title, body, status, created_by, decided_by)
         values ($1, $2, $3, $4, $5, 'proposed', $6, $6)`,
        [id, projectId, req.kind, req.title.trim(), req.body.trim(), actor ?? null],
      );
      await this.acceptKnowledge(q, id, actor ?? null);
      return this.getKnowledge(id, q);
    });
  }

  async updateKnowledge(id: string, req: UpdateKnowledgeRequest, actor?: string): Promise<KnowledgeDto> {
    return this.db.tx(async (q) => {
      const entry = await one(q.query("select * from knowledge where id = $1 for update", [id]), toKnowledge, "knowledge", id);
      await q.query(
        "update knowledge set kind = $2, title = $3, body = $4, updated_at = now() where id = $1",
        [id, req.kind ?? entry.kind, req.title?.trim() || entry.title, req.body?.trim() || entry.body],
      );
      if (req.status === "accepted" && entry.status !== "accepted") await this.acceptKnowledge(q, id, actor ?? null);
      else if (req.status && req.status !== entry.status) {
        await q.query("update knowledge set status = $2, decided_by = $3, updated_at = now() where id = $1", [id, req.status, actor ?? null]);
      }
      const updated = await this.getKnowledge(id, q);
      await appendEvent(q, {
        type: "KnowledgeUpdated",
        projectId: entry.projectId,
        payload: { knowledgeId: id, title: updated.title, status: updated.status, actor: actor ?? null },
      });
      return updated;
    });
  }

  /**
   * An agent reported what it learned. It stays "proposed" until its work is
   * merged (or its plan approved); a later attempt replaces the earlier notes.
   */
  private async proposeKnowledge(q: Queryable, task: TaskDto, notes: KnowledgeNote[]): Promise<void> {
    await q.query(
      "update knowledge set status = 'archived', decided_by = 'platform', updated_at = now() where source_task_id = $1 and status = 'proposed'",
      [task.id],
    );
    if (!notes.length) return;
    for (const n of notes) {
      await q.query(
        `insert into knowledge (id, project_id, kind, title, body, status, source_task_id, source_agent)
         values ($1, $2, $3, $4, $5, 'proposed', $6, $7)`,
        [randomUUID(), task.projectId, n.kind, n.title, n.body, task.id, task.agent],
      );
    }
    await appendEvent(q, {
      type: "KnowledgeProposed",
      projectId: task.projectId,
      taskId: task.id,
      payload: { agent: task.agent, titles: notes.map((n) => n.title) },
    });
  }

  private async acceptTaskKnowledge(q: Queryable, taskId: string, actor: string): Promise<void> {
    const rows = await q.query<{ id: string }>(
      "select id from knowledge where source_task_id = $1 and status = 'proposed' order by created_at",
      [taskId],
    );
    for (const r of rows) await this.acceptKnowledge(q, r.id, actor);
  }

  /** Accepts an entry; an accepted entry about the same fact is superseded. */
  private async acceptKnowledge(q: Queryable, id: string, actor: string | null): Promise<void> {
    const entry = await this.getKnowledge(id, q);
    const accepted = await this.listKnowledgeTx(q, entry.projectId, "accepted");
    for (const old of accepted.filter((k) => k.id !== id && sameKnowledge(k, entry))) {
      await q.query(
        "update knowledge set status = 'archived', superseded_by = $2, decided_by = $3, updated_at = now() where id = $1",
        [old.id, id, actor],
      );
    }
    await q.query("update knowledge set status = 'accepted', decided_by = $2, updated_at = now() where id = $1", [id, actor]);
    await appendEvent(q, {
      type: "KnowledgeAccepted",
      projectId: entry.projectId,
      ...(entry.sourceTaskId && { taskId: entry.sourceTaskId }),
      payload: { knowledgeId: id, kind: entry.kind, title: entry.title, actor },
    });
  }

  private async listKnowledgeTx(q: Queryable, projectId: string, status: KnowledgeStatus): Promise<KnowledgeDto[]> {
    return (await q.query(`${KNOWLEDGE_SELECT} where k.project_id = $1 and k.status = $2`, [projectId, status])).map(toKnowledge);
  }

  /** The accepted knowledge an agent gets, newest first per kind, within a size budget. */
  private async knowledgeContext(q: Queryable, projectId: string): Promise<KnowledgeContext[]> {
    const rows = await q.query(
      `${KNOWLEDGE_SELECT} where k.project_id = $1 and k.status = 'accepted'
       order by array_position($2::text[], k.kind), k.updated_at desc limit 200`,
      [projectId, [...KNOWLEDGE_KINDS]],
    );
    const context: KnowledgeContext[] = [];
    let size = 0;
    for (const r of rows) {
      size += r.title.length + r.body.length;
      if (size > KNOWLEDGE_CONTEXT_CHARS) break;
      context.push({ kind: r.kind, title: r.title, body: r.body, source: r.source_task_key ?? null });
    }
    return context;
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
  async cancelTask(id: string, actor?: string): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      if (isTerminal(task.state)) throw new ConflictError(`task ${task.key} is already ${task.state}`);
      // The provider may be merging the pull request right now; that cannot be undone.
      if (task.state === "MERGING") throw new ConflictError(`task ${task.key} is being merged and can no longer be cancelled`);
      await q.query(
        "update executions set cancel_requested = true where task_id = $1 and status = any($2::text[])",
        [id, ACTIVE],
      );
      return changeTaskState(q, task, "cancelled", { actor: actor ?? null });
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
    const active = await this.db.query(
      `select e.id, e.runner_id, e.status, e.attempt, t.id as task_id, t.key, t.agent from executions e
       join tasks t on t.id = e.task_id where e.status = any($1::text[]) order by e.created_at`,
      [ACTIVE],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      agents: r.agents as AgentDescriptor[],
      online: Boolean(r.online),
      registeredAt: iso(r.registered_at),
      lastSeenAt: iso(r.last_seen_at),
      activeExecutions: active
        .filter((e) => e.runner_id === r.id)
        .map((e) => ({ executionId: e.id, taskId: e.task_id, taskKey: e.key, agent: e.agent, status: e.status, attempt: e.attempt })),
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

      // Oldest READY tasks for our agents (or left to the scheduler), in projects
      // below their parallelism limit; the first one we can route wins.
      const candidates = await q.query(
        `select t.* from tasks t join projects p on p.id = t.project_id
         where t.state = 'READY' and (t.agent = any($1::text[]) or t.agent = '${AUTO}')
           and (p.max_parallel is null or (
             select count(*) from tasks w
             where w.project_id = t.project_id and w.state in ('ASSIGNED', 'RUNNING', 'VALIDATING')
           ) < p.max_parallel)
         order by t.created_at limit 20 for update of t skip locked`,
        [agentIds],
      );
      let picked: { task: TaskDto; routed?: { agent: string; reason: string } } | undefined;
      for (const row of candidates) {
        const candidate = toTask(row);
        if (candidate.agent !== AUTO) {
          picked = { task: candidate };
          break;
        }
        const policy = (await this.getProject(candidate.projectId, q)).routingPolicy;
        const choice = chooseAgent(
          runner.agents.map((a) => ({ id: a.id, skills: a.skills ?? [], cost: a.cost ?? "medium" })),
          { requires: candidate.requires, excluded: candidate.excludedAgents },
          await this.agentStats(candidate.projectId, q),
          policy,
        );
        if (choice) {
          picked = { task: candidate, routed: choice };
          break;
        }
      }
      if (!picked) return null;
      let task = picked.task;
      if (picked.routed) {
        const [updated] = await q.query("update tasks set agent = $2 where id = $1 returning *", [task.id, picked.routed.agent]);
        task = toTask(updated!);
        await appendEvent(q, {
          type: "AgentSelected",
          projectId: task.projectId,
          taskId: task.id,
          payload: { agent: picked.routed.agent, reason: picked.routed.reason, requires: task.requires },
        });
      }
      task = await changeTaskState(q, task, "assigned", { runnerId, agent: task.agent });

      const [previous] = await q.query<{ id: string; attempt: number }>(
        "select id, attempt from executions where task_id = $1 order by attempt desc limit 1",
        [task.id],
      );
      const project = await this.getProject(task.projectId, q);
      const rework = previous ? await this.reworkContext(q, project, previous.id, previous.attempt) : undefined;
      const approvals = previous ? await this.approvalDecisions(q, previous.id) : [];
      const dependencies = await this.dependencyContext(q, task);
      const review = task.kind === "review" && task.reviewOf ? await this.reviewTarget(q, task.reviewOf, project) : undefined;
      const plan = task.kind === "plan" && task.planId ? await this.planningContext(q, task.planId, project) : undefined;
      const knowledge = await this.knowledgeContext(q, project.id);
      const [lastSession] = await q.query<{ session_id: string; runner_id: string }>(
        `select session_id, runner_id from executions
         where task_id = $1 and session_id is not null and agent = $2 order by attempt desc limit 1`,
        [task.id, task.agent],
      );

      const executionToken = randomBytes(24).toString("base64url");
      const [execRow] = await q.query(
        `insert into executions (id, task_id, runner_id, attempt, status, token_hash, lease_expires_at, agent)
         values ($1, $2, $3, $4, 'assigned', $5, now() + make_interval(secs => $6), $7) returning *`,
        [randomUUID(), task.id, runnerId, (previous?.attempt ?? 0) + 1, sha256(executionToken), this.leaseSeconds, task.agent],
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
        ...(review && { review }),
        ...(plan && { plan }),
        ...(knowledge.length > 0 && { knowledge }),
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
       where execution_id = $1 and type in ('validation_result', 'review_result', 'merge_result', 'ci_result')
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
    if (row.type === "merge_result" && row.content.status === "base_changed") {
      return {
        kind: "base_changed",
        attempt,
        reason: `${project.defaultBranch} moved after the change was validated`,
        baseBranch: project.defaultBranch,
      };
    }
    if (row.type === "ci_result" && row.content.state === "failure") {
      const checks = (row.content.runs as CheckRun[]).filter((r) => r.state === "failure");
      return { kind: "ci", attempt, reason: `CI checks failed: ${checks.map((c) => c.name).join(", ")}`, checks };
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

  /** What a review task reviews: the delivered branch of the task and its context. */
  private async reviewTarget(q: Queryable, taskId: string, project: ProjectDto): Promise<ReviewTarget> {
    const target = await this.getTask(taskId, q);
    const [last] = await q.query<{ id: string; branch: string | null }>(
      "select id, branch from executions where task_id = $1 and branch is not null order by attempt desc limit 1",
      [taskId],
    );
    const latest = async (type: ArtifactType) =>
      (
        await q.query(
          "select content from artifacts where task_id = $1 and type = $2 order by created_at desc limit 1",
          [taskId, type],
        )
      )[0]?.content ?? null;
    return {
      taskId,
      taskKey: target.key,
      title: target.title,
      objective: target.objective,
      branch: last?.branch ?? `task/${target.key}`,
      baseBranch: project.defaultBranch,
      pullRequestUrl: target.pullRequestUrl,
      handoff: await latest("handoff"),
      validation: await latest("validation_result"),
      author: target.agent,
    };
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
      const { task, row } = await this.lockExecution(q, id, ["running"]);
      const audit = await this.auditsToolCalls(q, row.runner_id, task.agent);
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
        if (audit && event.kind === "tool_call") await this.auditToolCall(q, task, id, row.workspace, event);
      }
    });
  }

  /** Agents whose tool calls cannot be gated beforehand (approval "sandbox") are audited afterwards. */
  private async auditsToolCalls(q: Queryable, runnerId: string, agentId: string): Promise<boolean> {
    const [runner] = await q.query<{ agents: AgentDescriptor[] }>("select agents from runners where id = $1", [runnerId]);
    return runner?.agents.find((a) => a.id === agentId)?.capabilities.approval === "sandbox";
  }

  /**
   * Post-hoc policy check of a call the agent already made. A denial is
   * recorded like a hook denial, so the execution ends in needs_approval and
   * a human looks at it; human-approved actions count as allowed.
   */
  private async auditToolCall(
    q: Queryable,
    task: TaskDto,
    executionId: string,
    workspace: string,
    event: Extract<AgentEvent, { kind: "tool_call" }>,
  ): Promise<void> {
    const call = { tool: event.tool, input: event.input };
    let verdict = evaluateToolCall(call, { workspace });
    if (verdict.decision === "deny" && verdict.risk === "HIGH") {
      const [approved] = await q.query(
        "select id from approvals where task_id = $1 and action_key = $2 and status = 'approved' limit 1",
        [task.id, approvalKey(call)],
      );
      if (approved) verdict = { ...verdict, decision: "allow", reason: `${verdict.reason} (approved by a human: ${approved.id})` };
    }
    await appendEvent(q, {
      type: "ToolCallChecked",
      projectId: task.projectId,
      taskId: task.id,
      executionId,
      payload: { tool: event.tool, ...verdict, audit: true },
    });
  }

  /** The agent finished. On success the execution stays leased while the runner validates. */
  async completeExecution(id: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    const execution = await this.completeExecutionTx(id, req);
    await this.flushReviewComments();
    return execution;
  }

  private async completeExecutionTx(id: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
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
      // A review task is done once the agent answered; its result applies to the reviewed task.
      const review = task.kind === "review" && status === "validating" ? toReviewResult(t.kind === "completed" ? t.result : null) : undefined;
      if (task.kind === "review" && status === "validating" && !review) {
        return this.finishExecution(q, task, id, req, "failed", { reason: "the reviewer did not return a usable review" });
      }
      if (review) return this.finishReview(q, task, id, req, review);
      // A plan task is done once the planner proposed a usable DAG; a human decides on it.
      if (task.kind === "plan" && status === "validating") {
        const check = checkPlan(t.kind === "completed" ? t.result : null, { allowEmpty: true });
        if (!check.ok) {
          return this.finishExecution(q, task, id, req, "failed", { reason: `the planner did not return a usable plan: ${check.error}` });
        }
        return this.finishPlan(q, task, id, req, check.plan);
      }
      const stillActive = status === "validating";

      const [row] = await q.query(
        `update executions set status = $2, exit_code = $3, result = $4,
           finished_at = case when $6 then null else now() end,
           lease_expires_at = case when $6 then now() + make_interval(secs => $7) else null end,
           session_id = coalesce($5, session_id) where id = $1 returning *`,
        [id, status, req.exitCode, JSON.stringify(t), t.sessionId || null, stillActive, this.leaseSeconds],
      );
      if (req.revalidation) await q.query("update executions set revalidation = true where id = $1", [id]);
      await appendEvent(q, {
        type: "AgentFinished",
        projectId: task.projectId,
        taskId: task.id,
        executionId: id,
        payload: { status, exitCode: req.exitCode },
      });
      if (t.kind === "completed" && status !== "cancelled") {
        const handoff = toHandoff(t.result);
        await this.addArtifact(q, task, id, "handoff", handoff as unknown as Record<string, unknown>);
        if (status === "validating") await this.proposeKnowledge(q, task, handoff.knowledge);
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

  /** Ends an execution without validation (used by review tasks). */
  private async finishExecution(
    q: Queryable,
    task: TaskDto,
    id: string,
    req: CompleteExecutionRequest,
    status: "succeeded" | "failed",
    payload: Record<string, unknown> = {},
  ): Promise<ExecutionDto> {
    const t = req.terminal;
    const [row] = await q.query(
      `update executions set status = $2, exit_code = $3, result = $4, finished_at = now(), lease_expires_at = null,
         session_id = coalesce($5, session_id) where id = $1 returning *`,
      [id, status, req.exitCode, JSON.stringify(t), t.sessionId || null],
    );
    await appendEvent(q, {
      type: "AgentFinished",
      projectId: task.projectId,
      taskId: task.id,
      executionId: id,
      payload: { status, exitCode: req.exitCode, ...payload },
    });
    if (status === "failed" && !isTerminal(task.state)) await changeTaskState(q, task, "agent_failed", { executionId: id, ...payload });
    return toExecution(row!);
  }

  /**
   * Applies an agent review (spec §30) to the reviewed task: changes requested
   * send it back to rework with the findings; an approval either queues the
   * merge (autoApproveOnAgentReview) or leaves the final call to a human.
   */
  private async finishReview(
    q: Queryable,
    reviewTask: TaskDto,
    id: string,
    req: CompleteExecutionRequest,
    review: ReviewResult,
  ): Promise<ExecutionDto> {
    const execution = await this.finishExecution(q, reviewTask, id, req, "succeeded", { verdict: review.verdict });
    await this.addArtifact(q, reviewTask, id, "review_result", { ...review, reviewer: reviewTask.agent });
    if (!isTerminal(reviewTask.state)) await changeTaskState(q, reviewTask, "review_submitted", { verdict: review.verdict });

    const target = await this.getTask(reviewTask.reviewOf!, q);
    const project = await this.getProject(target.projectId, q);
    const reviewer = `agent ${reviewTask.agent}`;
    const comment = formatReview(review, reviewer);
    const [last] = await q.query<{ id: string }>(
      "select id from executions where task_id = $1 order by attempt desc limit 1",
      [target.id],
    );
    const decision = review.verdict === "approve" ? "approve" : "reject";
    await this.addArtifact(q, target, last?.id ?? null, "review_result", {
      decision,
      comment,
      reviewer,
      reviewTask: reviewTask.key,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings,
    });
    await appendEvent(q, {
      type: "AgentReviewCompleted",
      projectId: target.projectId,
      taskId: target.id,
      payload: { reviewer: reviewTask.agent, reviewTask: reviewTask.key, verdict: review.verdict, findings: review.findings.length },
    });
    // A human may have decided in the meantime; their decision stands.
    if (target.state === "REVIEW") {
      if (review.verdict === "request_changes") {
        await changeTaskState(q, target, "review_rejected", { comment: review.summary, actor: reviewer });
      } else if (project.autoApproveOnAgentReview) {
        // Changing what "passing" means is for a person to approve, not an agent.
        const ciFiles = await this.changedCiConfig(q, target.id);
        if (ciFiles.length) {
          await appendEvent(q, {
            type: "AutoApprovalSkipped",
            projectId: target.projectId,
            taskId: target.id,
            payload: { reason: "the change modifies CI configuration", files: ciFiles },
          });
        } else {
          await changeTaskState(q, target, "review_approved", { comment: review.summary, actor: reviewer });
        }
      }
    }
    this.pendingReviewComments.push({ project, target, body: comment });
    return execution;
  }

  /** CI configuration files among the task's latest validated changes. */
  private async changedCiConfig(q: Queryable, taskId: string): Promise<string[]> {
    const [row] = await q.query<{ files: string[] | null }>(
      `select content->'changedFiles' as files from artifacts
       where task_id = $1 and type = 'validation_result' order by created_at desc limit 1`,
      [taskId],
    );
    return (row?.files ?? []).filter(isCiConfigPath);
  }

  /** Creates a review task for a delivered task, with a reviewer other than its author. */
  private async requestAgentReview(taskId: string): Promise<void> {
    await this.db.tx(async (q) => {
      const task = await this.getTask(taskId, q);
      const project = await this.getProject(task.projectId, q);
      const reviewers = project.reviewAgents.filter((a) => a !== task.agent);
      const reviewer = reviewers[0];
      if (task.kind !== "work" || !reviewer) return;
      const [p] = await q.query<{ key: string; task_seq: number }>(
        "update projects set task_seq = task_seq + 1 where id = $1 returning key, task_seq",
        [project.id],
      );
      const key = `${p!.key}-${p!.task_seq}`;
      const [row] = await q.query(
        `insert into tasks (id, project_id, key, title, objective, agent, state, max_attempts, kind, review_of,
           fallback_agents, excluded_agents)
         values ($1, $2, $3, $4, $5, $6, 'CREATED', 2, 'review', $7, $8, $9) returning *`,
        [
          randomUUID(),
          project.id,
          key,
          `Review ${task.key}: ${task.title}`,
          `Review the changes delivered for ${task.key} ("${task.title}") by ${task.agent}.`,
          reviewer,
          task.id,
          JSON.stringify(reviewers.slice(1)),
          // The author never reviews its own work, even as a fallback.
          JSON.stringify([task.agent]),
        ],
      );
      const reviewTask = toTask(row!);
      await appendEvent(q, {
        type: "TaskCreated",
        projectId: project.id,
        taskId: reviewTask.id,
        payload: { key, title: reviewTask.title, agent: reviewer, reviewOf: task.key },
      });
      await appendEvent(q, {
        type: "AgentReviewRequested",
        projectId: project.id,
        taskId: task.id,
        payload: { reviewer, reviewTask: key },
      });
      await changeTaskState(q, reviewTask, "dependencies_satisfied");
    });
  }

  /** Review comments to post on pull requests once their transaction committed. */
  private pendingReviewComments: Array<{ project: ProjectDto; target: TaskDto; body: string }> = [];

  /** Posts queued agent reviews as pull request comments (best effort). */
  async flushReviewComments(): Promise<void> {
    const pending = this.pendingReviewComments.splice(0);
    for (const { project, target, body } of pending) {
      if (!target.pullRequestNumber || !this.gitProvider?.commentOnPullRequest) continue;
      try {
        await this.gitProvider.commentOnPullRequest({ repoUrl: project.repoUrl, number: target.pullRequestNumber, body });
      } catch (err) {
        await appendEvent(this.db, {
          type: "PullRequestCommentFailed",
          projectId: target.projectId,
          taskId: target.id,
          payload: { error: String(err) },
        });
      }
    }
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
    const response = await this.deliver(id, req);
    const [execution] = await this.db.query<{ task_id: string; revalidation: boolean }>(
      "select task_id, revalidation from executions where id = $1",
      [id],
    );
    if (!execution || req.error) return response;
    if (execution.revalidation) {
      // Only the base was merged in and it validated: the approval still stands.
      await this.db.tx(async (q) => {
        const task = await this.getTask(execution.task_id, q);
        if (task.state === "REVIEW") {
          await changeTaskState(q, task, "review_approved", { actor: "platform", comment: "re-validated on the latest base" });
        }
      });
    } else if (req.commitSha) {
      // The pushed branch is what gets reviewed (with or without a pull request).
      await this.requestAgentReview(execution.task_id);
    }
    return response;
  }

  private async deliver(id: string, req: DeliveryRequest): Promise<DeliveryResponse> {
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
  async decideApproval(
    id: string,
    status: "approved" | "rejected",
    comment?: string,
    actor: Actor = { name: "local", role: "owner" },
  ): Promise<ApprovalDto> {
    return this.db.tx(async (q) => {
      const row = (await q.query("select * from approvals where id = $1 for update", [id]))[0];
      if (!row) throw new NotFoundError("approval", id);
      if (row.status !== "pending") throw new ConflictError(`approval ${id} is already ${row.status}`);
      // Spec §32: HIGH risk needs a senior developer (owners can always decide).
      const needed = row.risk === "HIGH" ? "senior" : "member";
      if (!hasRole(actor, needed)) throw new ForbiddenError(`${row.risk} risk approvals require role ${needed}`);
      const [updated] = await q.query(
        "update approvals set status = $2, comment = $3, decided_by = $4, decided_at = now() where id = $1 returning *",
        [id, status, comment ?? null, actor.name],
      );
      await appendEvent(q, {
        type: status === "approved" ? "ApprovalGranted" : "ApprovalRejected",
        projectId: row.project_id,
        taskId: row.task_id,
        executionId: row.execution_id,
        payload: { approvalId: id, summary: row.summary, comment: comment ?? null, actor: actor.name },
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
  async retryTask(id: string, actor?: string): Promise<TaskDto> {
    return this.db.tx(async (q) => {
      const task = await one(q.query("select * from tasks where id = $1 for update", [id]), toTask, "task", id);
      const payload = { reason: "retried by a human", actor: actor ?? null };
      if (task.state === "WAITING_FOR_HUMAN") return changeTaskState(q, task, "unassigned", payload);
      if (task.state === "BLOCKED") return changeTaskState(q, task, "unblocked", payload);
      throw new ConflictError(`task ${task.key} is ${task.state}; only WAITING_FOR_HUMAN or BLOCKED tasks can be retried`);
    });
  }

  /** Human review of a delivered task (spec §30): approve queues the merge, reject sends it to rework. */
  async reviewTask(id: string, req: ReviewRequest, actor?: string): Promise<TaskDto> {
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
        reviewer: actor ?? null,
      });
      return changeTaskState(q, task, req.decision === "approve" ? "review_approved" : "review_rejected", {
        comment: req.comment ?? null,
        actor: actor ?? null,
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
    const result: MergeQueueResult = { merged: 0, conflicts: 0, failed: 0, revalidating: 0, waiting: 0, ciFailed: 0 };
    // An in-flight MERGING task of a project goes first; otherwise its oldest APPROVED task.
    const next = await this.db.query(
      `select distinct on (project_id) * from tasks where state in ('MERGING', 'APPROVED')
       order by project_id, (state = 'MERGING') desc, updated_at`,
    );
    for (const row of next) {
      await withSpan(
        `merge_queue ${row.key}`,
        { "mar.task.key": row.key, "mar.task.id": row.id, "mar.task.state": row.state },
        (span) => this.processMergeQueueTask(toTask(row), result).then((outcome) => void span.setAttribute("mar.merge.outcome", outcome)),
        { root: true },
      );
    }
    return result;
  }

  /** One step of the merge queue for one task; returns what happened, for the trace. */
  private async processMergeQueueTask(task: TaskDto, result: MergeQueueResult): Promise<string> {
    const [last] = await this.db.query<{ id: string; branch: string | null }>(
      "select id, branch from executions where task_id = $1 order by attempt desc limit 1",
      [task.id],
    );
    if (task.state === "APPROVED") {
      try {
        task = await this.db.tx((q) => changeTaskState(q, task, "merge_started"));
      } catch (err) {
        if (err instanceof ConflictError) return "taken"; // another worker took it
        throw err;
      }
    }

    if (!task.pullRequestNumber || !this.gitProvider) {
      // Nothing to merge (no changes, or no provider): the reviewed work is accepted as is.
      await this.finishMerge(task, last?.id ?? null, { status: "merged", sha: null }, "no pull request to merge");
      result.merged++;
      return "merged";
    }

    const project = await this.getProject(task.projectId);
    if (this.gitProvider.pullRequestStatus && (project.revalidateOnBaseChange || project.waitForChecks)) {
      let status: PullRequestStatus;
      try {
        status = await this.gitProvider.pullRequestStatus({ repoUrl: project.repoUrl, number: task.pullRequestNumber });
      } catch (err) {
        result.failed++;
        await this.recordMergeFailure(task, String(err));
        return "failed";
      }
      // Spec §27: what was validated is not what would be merged. Validate the combination first.
      if (project.revalidateOnBaseChange && status.behindBase) {
        await this.leaveMergeQueue(task, last?.id ?? null, "base_changed", "merge_result", {
          status: "base_changed",
          headSha: status.headSha,
        });
        result.revalidating++;
        return "base_changed";
      }
      if (project.waitForChecks) {
        const gate = await this.checksGate(task, last?.id ?? null, status);
        if (gate === "wait") {
          result.waiting++;
          return "waiting_for_ci";
        }
        if (gate === "failed") {
          result.ciFailed++;
          return "ci_failed";
        }
      }
    }
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
      return "failed";
    }
    if (merge.status === "pending") return "pending"; // retried on the next tick
    await this.finishMerge(task, last?.id ?? null, merge);
    if (merge.status === "merged") result.merged++;
    else result.conflicts++;
    return merge.status;
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
        await this.acceptTaskKnowledge(q, completed.id, "platform");
        await this.unlockDependents(q, completed);
      } else {
        await changeTaskState(q, current, "merge_conflict", { message: merge.message });
      }
    });
  }

  /**
   * CI gate (spec §34): failed checks send the task back to its agent with
   * the failures; pending checks hold the project's queue. A pull request that
   * reports no check at all within the grace period is merged without CI.
   */
  private async checksGate(task: TaskDto, executionId: string | null, status: PullRequestStatus): Promise<"ok" | "wait" | "failed"> {
    const { state, runs } = status.checks;
    const once = async (type: string, payload: Record<string, unknown>) => {
      const [seen] = await this.db.query(
        "select 1 from events where task_id = $1 and type = $2 and payload->>'headSha' = $3 limit 1",
        [task.id, type, status.headSha],
      );
      if (!seen) await appendEvent(this.db, { type, projectId: task.projectId, taskId: task.id, payload: { headSha: status.headSha, ...payload } });
    };
    if (state === "failure") {
      await this.leaveMergeQueue(task, executionId, "ci_failed", "ci_result", { state, runs, headSha: status.headSha });
      return "failed";
    }
    if (state === "success") {
      await once("CiPassed", { checks: runs.map((r) => r.name) });
      return "ok";
    }
    if (state === "none" && Date.now() - Date.parse(task.updatedAt) > this.ciGraceSeconds * 1000) {
      await once("CiSkipped", { reason: `no CI check reported within ${this.ciGraceSeconds}s` });
      return "ok";
    }
    await once("CiPending", { checks: runs.filter((r) => r.state === "pending").map((r) => r.name) });
    return "wait";
  }

  /** Takes a MERGING task out of the queue and back to rework, with what the queue found. */
  private async leaveMergeQueue(
    task: TaskDto,
    executionId: string | null,
    trigger: "base_changed" | "ci_failed",
    artifact: "merge_result" | "ci_result",
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.db.tx(async (q) => {
      const current = await this.getTask(task.id, q);
      if (current.state !== "MERGING") return;
      await this.addArtifact(q, current, executionId, artifact, content);
      await appendEvent(q, {
        type: trigger === "base_changed" ? "BaseChanged" : "CiFailed",
        projectId: task.projectId,
        taskId: task.id,
        payload:
          trigger === "base_changed"
            ? { headSha: content.headSha }
            : { headSha: content.headSha, checks: (content.runs as CheckRun[]).filter((r) => r.state === "failure").map((r) => r.name) },
      });
      await changeTaskState(q, current, trigger);
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
        `select t.*, (select count(*) from executions e where e.task_id = t.id and not e.revalidation)::int as attempts
         from tasks t where t.state in ('RETRYING', 'REWORK') for update skip locked`,
      );
      for (const row of retrying) {
        const task = row.state === "RETRYING" ? await this.maybeReassign(q, toTask(row)) : toTask(row);
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

  /**
   * Spec §46: when the agent is unavailable (quota, rate limit, login) or
   * failed the task twice in a row, move the task to another agent: auto
   * routing excludes it and lets the scheduler choose again; fixed routing
   * switches to the next fallback agent.
   */
  private async maybeReassign(q: Queryable, task: TaskDto): Promise<TaskDto> {
    const recent = await q.query<{ agent: string | null; status: string; result: any }>(
      "select agent, status, result from executions where task_id = $1 order by attempt desc limit 2",
      [task.id],
    );
    const last = recent[0];
    if (!last?.agent || last.agent !== task.agent) return task;
    const reason = String(last.result?.reason ?? "");
    const unavailable = isAgentUnavailable(reason);
    const repeated = recent.length === 2 && recent.every((e) => e.agent === last.agent && ["failed", "lost"].includes(e.status));
    if (!unavailable && !repeated) return task;

    const excluded = [...new Set([...task.excludedAgents, last.agent])];
    const next =
      task.routing === "auto" ? AUTO : task.fallbackAgents.find((a) => !excluded.includes(a) && a !== task.agent);
    if (!next) return task;
    const [row] = await q.query("update tasks set agent = $2, excluded_agents = $3 where id = $1 returning *", [
      task.id,
      next,
      JSON.stringify(excluded),
    ]);
    await appendEvent(q, {
      type: "TaskReassigned",
      projectId: task.projectId,
      taskId: task.id,
      payload: { from: last.agent, to: next, reason: unavailable ? `agent unavailable: ${reason.slice(0, 200)}` : "failed twice in a row" },
    });
    return toTask(row!);
  }

  /** Execution history per agent (spec §40), optionally for one project. */
  async agentStats(projectId?: string, q: Queryable = this.db): Promise<AgentStats[]> {
    const rows = await q.query(
      `select e.agent,
         count(*)::int as executions,
         count(*) filter (where e.status = 'succeeded')::int as succeeded,
         count(*) filter (where e.status in ('failed', 'lost'))::int as failed,
         count(*) filter (where e.status in ('assigned', 'running', 'validating', 'delivering'))::int as active,
         avg(extract(epoch from (e.finished_at - e.started_at)) * 1000)
           filter (where e.finished_at is not null and e.started_at is not null) as avg_ms,
         count(*) filter (where exists (
           select 1 from artifacts a where a.execution_id = e.id and (
             (a.type = 'validation_result' and a.content->>'passed' = 'false') or
             (a.type = 'review_result' and a.content->>'decision' = 'reject'))))::int as reworked
       from executions e join tasks t on t.id = e.task_id
       where e.agent is not null and ($1::uuid is null or t.project_id = $1)
       group by e.agent order by e.agent`,
      [projectId ?? null],
    );
    return rows.map((r) => ({
      agent: r.agent,
      executions: r.executions,
      succeeded: r.succeeded,
      failed: r.failed,
      active: r.active,
      avgDurationMs: r.avg_ms == null ? null : Math.round(Number(r.avg_ms)),
      reworkRate: r.executions ? Math.round((r.reworked / r.executions) * 1000) / 1000 : 0,
    }));
  }

  // ---- events -------------------------------------------------------------

  async listEvents(
    /** Empty filter = all events. */
    filter: { projectId?: string; taskId?: string; executionId?: string },
    after = 0,
    limit = 200,
  ): Promise<EventDto[]> {
    const [column, value] = filter.executionId
      ? ["execution_id", filter.executionId]
      : filter.taskId
        ? ["task_id", filter.taskId]
        : filter.projectId
          ? ["project_id", filter.projectId]
          : [undefined, undefined];
    const rows = column
      ? await this.db.query(`select e.*, t.key as task_key from events e left join tasks t on t.id = e.task_id where e.${column} = $1 and e.seq > $2 order by e.seq limit $3`, [value, after, limit])
      : await this.db.query("select e.*, t.key as task_key from events e left join tasks t on t.id = e.task_id where e.seq > $1 order by e.seq limit $2", [after, limit]);
    return rows.map(toEvent);
  }

  /** Most recent events, newest first (activity feeds). */
  async recentEvents(limit: number, projectId?: string): Promise<EventDto[]> {
    const rows = projectId
      ? await this.db.query("select e.*, t.key as task_key from events e left join tasks t on t.id = e.task_id where e.project_id = $1 order by e.seq desc limit $2", [projectId, limit])
      : await this.db.query("select e.*, t.key as task_key from events e left join tasks t on t.id = e.task_id order by e.seq desc limit $1", [limit]);
    return rows.map(toEvent);
  }

  /** Position of an event log consumer (null: never ran). */
  async eventCursor(name: string): Promise<number | null> {
    const [row] = await this.db.query<{ seq: string | number }>("select seq from event_cursors where name = $1", [name]);
    return row ? Number(row.seq) : null;
  }

  async setEventCursor(name: string, seq: number): Promise<void> {
    await this.db.query(
      `insert into event_cursors (name, seq) values ($1, $2)
       on conflict (name) do update set seq = excluded.seq, updated_at = now()`,
      [name, seq],
    );
  }

  async latestEventSeq(): Promise<number> {
    const [row] = await this.db.query<{ seq: string | number | null }>("select max(seq) as seq from events");
    return Number(row?.seq ?? 0);
  }

  /** Of the given task keys, those whose task is finished (worktree no longer needed). */
  async finishedTaskKeys(keys: string[]): Promise<string[]> {
    if (!keys.length) return [];
    const rows = await this.db.query<{ key: string }>(
      "select key from tasks where key = any($1::text[]) and state in ('COMPLETED', 'CANCELLED')",
      [keys],
    );
    return rows.map((r) => r.key);
  }

  /**
   * On control plane start: runners could not heartbeat while it was down, so
   * give every active execution a fresh lease instead of declaring them lost.
   */
  async extendActiveLeases(): Promise<number> {
    const rows = await this.db.query(
      `update executions set lease_expires_at = now() + make_interval(secs => $2)
       where status = any($1::text[]) returning id`,
      [ACTIVE, this.leaseSeconds],
    );
    if (rows.length) await appendEvent(this.db, { type: "LeasesExtendedOnStartup", payload: { executions: rows.length } });
    return rows.length;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
