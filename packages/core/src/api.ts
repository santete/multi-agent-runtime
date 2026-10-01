/** Wire types shared by the control plane HTTP API and its clients (runner, UI). */
import type { AdapterCapabilities, AgentEvent } from "./adapter.js";
import type { KnowledgeKind, KnowledgeStatus } from "./knowledge.js";
import type { PlanCritique, PlannedTask, PlanProposal } from "./plan.js";
import type { Budget, Pricing } from "./cost.js";
import type { ProjectPolicy } from "./policy.js";
import type { SecretScope } from "./secrets.js";
import type { CostTier, RoutingPolicy } from "./routing.js";
import type { TaskState } from "./task-state.js";

/**
 * Runs the validation steps in a throwaway container instead of on the
 * runner's host (ADR-0018): the worktree is mounted at /workspace.
 */
export interface ValidationSandbox {
  /** Container image with the project's toolchain, e.g. "node:22-alpine". */
  image: string;
  /** Network access during validation (default: none). */
  network?: boolean | undefined;
  /** Memory limit, e.g. "2g". */
  memory?: string | undefined;
  /** CPU limit, e.g. 2. */
  cpus?: number | undefined;
}

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
  /** Max tasks of this project working at once (null = unlimited). */
  maxParallel: number | null;
  /** Agents that review delivered tasks; one different from the task's agent is picked. */
  reviewAgents: string[];
  /** An agent approval also approves the task for merging (otherwise a human still reviews). */
  autoApproveOnAgentReview: boolean;
  /** How the scheduler weighs reliability, cost and load when it picks an agent. */
  routingPolicy: RoutingPolicy;
  /** Re-validate a task on the latest base branch before merging it when the base moved (default true). */
  revalidateOnBaseChange: boolean;
  /** Wait for the pull request's CI checks to pass before merging (spec §34). */
  waitForChecks: boolean;
  /** Run validation in a container (null: on the runner's host). */
  validationSandbox: ValidationSandbox | null;
  /** Spending limits (spec §39); null: unlimited. */
  budget: Budget | null;
  /** What to do when the base branch's CI fails on a merged task (spec §46). */
  onBrokenMain: BrokenMainPolicy;
  /** Debate and autonomy of assisted planning (spec §53). */
  planning: PlanningPolicy;
  /** Tool-call rules, allowed hosts and approvers of this project (spec §47). */
  policy: ProjectPolicy;
  /** The organization the project belongs to (spec §49). */
  orgId: string;
  /** Agents allowed to work on the project (project-level agents); empty = any. */
  allowedAgents: string[];
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
  /** "auto": the scheduler picks the agent by `requires` (agent is "auto" until then). */
  routing: "fixed" | "auto";
  /** Skills the agent must have (auto routing). */
  requires: string[];
  /** Agents to switch to when the agent keeps failing or is unavailable (fixed routing). */
  fallbackAgents: string[];
  /** Agents that failed this task and will not get it again. */
  excludedAgents: string[];
  /**
   * "review": an agent review of another task (reviewOf); it produces a review, not code.
   * "plan": a planner run for a plan (planId); it produces a proposed task DAG.
   */
  kind: "work" | "review" | "plan" | "critique";
  reviewOf: string | null;
  /** The plan this task was planned in (work tasks) or plans (plan tasks). */
  planId: string | null;
  /** Ids of tasks that must be COMPLETED (merged) before this one becomes READY. */
  dependsOn: string[];
  /** 0 (whenever) … 100 (urgent); the scheduler adds the critical path and waiting time. */
  priority: number;
  /**
   * Parts of the repository the task works on (globs, spec §27): tasks with
   * overlapping areas do not run at the same time. Empty = undeclared.
   */
  paths: string[];
  /** Set once the task's branch has been delivered as a pull request. */
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
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
  /** Stopped by a person to pause the task or give it a new instruction (spec §43); not a failed attempt. */
  | "interrupted"
  | "lost";

export const ACTIVE_EXECUTION_STATUSES: readonly ExecutionStatus[] = ["assigned", "running", "validating", "delivering"];

export interface ExecutionDto {
  id: string;
  taskId: string;
  runnerId: string;
  attempt: number;
  /** Agent that ran this attempt. */
  agent: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD; null when unknown. */
  costUsd: number | null;
  /** costUsd was estimated from token usage and the agent's pricing. */
  costEstimated: boolean;
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
  /** Key of the task (e.g. PAY-3), for display. */
  taskKey: string | null;
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
  maxParallel?: number | undefined;
  reviewAgents?: string[] | undefined;
  autoApproveOnAgentReview?: boolean | undefined;
  routingPolicy?: RoutingPolicy | undefined;
  revalidateOnBaseChange?: boolean | undefined;
  waitForChecks?: boolean | undefined;
  validationSandbox?: ValidationSandbox | null | undefined;
  budget?: Budget | null | undefined;
  onBrokenMain?: BrokenMainPolicy | undefined;
  planning?: { [K in keyof PlanningPolicy]?: PlanningPolicy[K] | undefined } | undefined;
  /** Platform admins only; everyone else creates projects in their own organization. */
  orgId?: string | undefined;
  allowedAgents?: string[] | undefined;
}

/** An organization (spec §49): its projects, runners and agent catalog are its own. */
export interface OrgDto {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * A reusable agent definition in the marketplace (spec §53): how to run it,
 * what it is good at and what it costs, plus instructions every task it runs
 * gets. Published to one organization, or to everyone (orgId null).
 */
export interface AgentProfileDto {
  id: string;
  orgId: string | null;
  name: string;
  version: number;
  adapter: string;
  description: string;
  skills: string[];
  cost: CostTier;
  pricing: Pricing | null;
  instructions: string;
  publishedBy: string | null;
  deprecated: boolean;
  createdAt: string;
  /** Measured on the executions of agents built from this profile (any version). */
  usage: { executions: number; succeeded: number; failed: number };
}

export interface PublishAgentProfileRequest {
  name: string;
  adapter: string;
  description?: string | undefined;
  skills?: string[] | undefined;
  cost?: CostTier | undefined;
  pricing?: Pricing | undefined;
  instructions?: string | undefined;
  /** Publish to every organization (platform admins only). */
  public?: boolean | undefined;
}

/**
 * notify: tell people; revert: also open a pull request reverting the merge
 * (a person merges it); fix: also give the task's agent a fix-forward task.
 */
export type BrokenMainPolicy = "notify" | "revert" | "fix";

/**
 * critics: agents that critique each proposal (a different agent than the
 * planner); maxRounds: planner/critic rounds before a person decides;
 * autoApprove: approve without a person when the critic approves and the
 * plan stays within maxAutoTasks with agents available for every task.
 */
export interface PlanningPolicy {
  critics: string[];
  maxRounds: number;
  autoApprove: boolean;
  maxAutoTasks: number;
}

/** What a critic agent gets with its task. */
export interface CritiqueContext {
  planId: string;
  goal: string;
  round: number;
  baseBranch: string;
  proposal: PlanProposal;
  /** Agents online, so the critic can judge assignments. */
  agents: Array<{ id: string; skills: string[] }>;
  planner: string;
}

/** An agent resting after it hit its quota on a runner (spec §39, §46). */
export interface AgentCooldown {
  runnerId: string;
  runnerName: string;
  agent: string;
  until: string;
  reason: string;
}

/** Spend of a project, per day and agent. */
export interface CostReport {
  projectId: string;
  budget: Budget | null;
  /** Spent since midnight (UTC). */
  todayUsd: number;
  rows: Array<{
    day: string;
    agent: string;
    executions: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** Some of the cost is estimated from pricing. */
    estimated: boolean;
  }>;
}

/** A READY task in the order the scheduler takes them (spec §53). */
export interface QueueEntry {
  taskId: string;
  key: string;
  title: string;
  agent: string;
  priority: number;
  score: number;
  reasons: string[];
  /** Waits for an unmerged task whose area overlaps (spec §27). */
  blockedBy: { key: string; path: string } | null;
}

/** The executor id of tasks a person does (spec §61). */
export const HUMAN_EXECUTOR = "human";

/** A question an agent could not decide alone (spec §61: Decision Request). */
export interface DecisionDto {
  id: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  projectId: string;
  executionId: string;
  agent: string;
  question: string;
  options: string[];
  context: string;
  status: "pending" | "answered";
  answer: string | null;
  answeredBy: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface MergePolicy {
  revalidateOnBaseChange: boolean;
  waitForChecks: boolean;
}

/** One CI check of a pull request (GitHub check run or commit status). */
export interface CheckRun {
  name: string;
  state: "pending" | "success" | "failure" | "neutral";
  url: string | null;
  /** What the check reported (e.g. the failing test), when it says. */
  summary: string | null;
}

/** Overall CI state of a commit: "none" when no check reported anything. */
export type ChecksState = "none" | "pending" | "success" | "failure";

export interface ReviewPolicy {
  reviewAgents: string[];
  autoApproveOnAgentReview: boolean;
}

export type ArtifactType = "handoff" | "validation_result" | "review_result" | "merge_result" | "plan_proposal" | "plan_critique" | "ci_result" | "diff";

/** An entry of the project's shared knowledge base (spec §20, §35). */
export interface KnowledgeDto {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  status: KnowledgeStatus;
  /** The task whose agent reported it (null: written by a person). */
  sourceTaskId: string | null;
  sourceTaskKey: string | null;
  sourceAgent: string | null;
  createdBy: string | null;
  /** Who accepted or archived it ("platform" when the task was merged). */
  decidedBy: string | null;
  /** The entry that replaced it. */
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeRequest {
  kind: KnowledgeKind;
  title: string;
  body: string;
}

export interface UpdateKnowledgeRequest {
  kind?: KnowledgeKind | undefined;
  title?: string | undefined;
  body?: string | undefined;
  status?: KnowledgeStatus | undefined;
}

/** Accepted knowledge handed to an agent with its task. */
export interface KnowledgeContext {
  kind: KnowledgeKind;
  title: string;
  body: string;
  /** Key of the task it came from. */
  source: string | null;
}

export interface ReviewRequest {
  decision: "approve" | "reject";
  comment?: string | undefined;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** A risky tool call an agent attempted that needs a human decision (spec §31). */
export interface ApprovalDto {
  id: string;
  projectId: string;
  taskId: string;
  executionId: string;
  tool: string;
  input: unknown;
  summary: string;
  risk: string;
  reason: string;
  status: ApprovalStatus;
  comment: string | null;
  /** Name of the human who decided (audit). */
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface DecideApprovalRequest {
  comment?: string | undefined;
}

export interface TaskGraph {
  nodes: TaskDto[];
  /** `from` must be completed before `to` can start. */
  edges: Array<{ from: string; to: string }>;
}

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
  /** An agent id, or "auto" to let the scheduler pick one with the `requires` skills. */
  agent: string;
  requires?: string[] | undefined;
  fallbackAgents?: string[] | undefined;
  priority?: number | undefined;
  paths?: string[] | undefined;
  maxAttempts?: number | undefined;
  /** Ids or keys of tasks in the same project that must be merged first. */
  dependsOn?: string[] | undefined;
}

/** An agent a runner offers (agent registry, spec §14). */
export interface AgentDescriptor {
  /** Logical agent id tasks ask for, e.g. "claude-code". */
  id: string;
  /** Adapter that runs it, e.g. "claude-code", "antigravity", "generic-cli". */
  adapter: string;
  capabilities: AdapterCapabilities;
  /** What the agent is good at (languages, frameworks, task types), for routing. */
  skills?: string[] | undefined;
  /** Relative cost of using the agent. */
  cost?: CostTier | undefined;
  /** List price, to estimate cost when the CLI does not report it. */
  pricing?: Pricing | undefined;
  /** At most this many executions of the agent at once on the runner (subscription limits). */
  maxConcurrent?: number | undefined;
  /**
   * Marketplace profile the agent is built from ("name" for the latest, or
   * "name@version"); the control plane fills in what the runner left out and
   * records the resolved "name@version".
   */
  profile?: string | undefined;
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
  orgId: string;
  online: boolean;
  registeredAt: string;
  lastSeenAt: string;
  /** What the runner is working on right now (spec §42 agent overview). */
  activeExecutions: Array<{
    executionId: string;
    taskId: string;
    taskKey: string;
    agent: string;
    status: ExecutionStatus;
    attempt: number;
  }>;
}

export interface ActorDto {
  name: string;
  role: "viewer" | "member" | "senior" | "owner" | "runner";
  /** Organization (spec §49); "*" for platform admins. */
  org: string;
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
  /** Handoffs of the tasks this one depends on (spec §21, shared context). */
  dependencies?: DependencyContext[];
  /** Human decisions on actions the previous attempt was not allowed to take. */
  approvals?: ApprovalDecision[];
  /** For review tasks: what to review. */
  review?: ReviewTarget;
  /** For plan tasks: what to plan. */
  plan?: PlanningContext;
  /** For critique tasks: the proposal to critique. */
  critique?: CritiqueContext;
  /** Instructions of the agent's marketplace profile, for every task it runs. */
  agentInstructions?: string;
  /** Answers a person gave to the previous attempt's open questions (spec §61). */
  decisions?: Array<{ question: string; answer: string; answeredBy: string | null }>;
  /** What people told the agent since its last run (spec §43), oldest first. */
  instructions?: InstructionDto[];
  /**
   * The project's secrets for this run (spec §48): names only. The runner
   * fetches the values with GET /executions/:id/secrets while the run lasts.
   */
  secrets?: Array<{ name: string; exposeTo: SecretScope[] }>;
  /** The project's accepted knowledge (spec §21: no agent re-analyses the project). */
  knowledge?: KnowledgeContext[];
}

/**
 * Assisted planning (spec §24). planning: the planner agent is working;
 * proposed: waiting for a human; failed: the planner gave up (see its task).
 */
export type PlanStatus = "planning" | "reviewing" | "proposed" | "approved" | "rejected" | "revised" | "failed";

export interface PlanDto {
  id: string;
  projectId: string;
  goal: string;
  status: PlanStatus;
  /** The planner task (its executions and events show the planning run). */
  plannerTaskId: string | null;
  plannerTaskKey: string | null;
  plannerAgent: string | null;
  proposal: PlanProposal | null;
  /** Tasks created when the plan was approved, by planned ref. */
  createdTasks: Array<{ ref: string; taskId: string; key: string }>;
  /** Debate round: 1 for the first proposal, +1 for each revision. */
  round: number;
  /** The critic's verdict on this proposal. */
  critique: (PlanCritique & { critic: string }) | null;
  /** Human feedback this plan revises (see previousPlanId). */
  feedback: string | null;
  previousPlanId: string | null;
  createdBy: string | null;
  decidedBy: string | null;
  comment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface CreatePlanRequest {
  goal: string;
  /** The planner agent, or "auto". */
  agent: string;
}

export interface ApprovePlanRequest {
  /** The tasks as edited by the reviewer; the proposal as is when omitted. */
  tasks?: PlannedTask[] | undefined;
  comment?: string | undefined;
}

export interface RevisePlanRequest {
  /** What the planner should change. */
  feedback: string;
}

/** What a planner agent gets to plan with. */
export interface PlanningContext {
  planId: string;
  goal: string;
  baseBranch: string;
  /** Agents registered on runners, to assign or route by skills. */
  agents: Array<{ id: string; skills: string[]; cost: CostTier | null }>;
  /** Unfinished tasks of the project, which planned tasks may depend on. */
  openTasks: Array<{ key: string; title: string; state: TaskState }>;
  /** When revising: the rejected proposal and what to change. */
  previous?: { proposal: PlanProposal; feedback: string } | undefined;
}

export interface ReviewTarget {
  taskId: string;
  taskKey: string;
  title: string;
  objective: string;
  /** Branch with the delivered work (pushed). */
  branch: string;
  baseBranch: string;
  pullRequestUrl: string | null;
  handoff: Record<string, unknown> | null;
  validation: ValidationReport | null;
  /** Agent that did the work. */
  author: string;
}

/**
 * base_changed: the base branch moved after validation; the runner merges it
 * in and re-validates (the agent only runs when that conflicts or fails).
 * ci: the pull request's CI checks failed.
 */
export interface ReworkContext {
  kind: "validation" | "review" | "merge_conflict" | "base_changed" | "ci";
  /** Attempt that produced the rejected work. */
  attempt: number;
  reason: string;
  validation?: ValidationReport;
  /** Reviewer's comment when the review was rejected. */
  comment?: string;
  /** Branch to merge in when the task conflicts with it or it moved. */
  baseBranch?: string;
  /** The CI checks that failed. */
  checks?: CheckRun[];
}

export interface DependencyContext {
  key: string;
  title: string;
  handoff: Record<string, unknown> | null;
}

export interface ApprovalDecision {
  tool: string;
  summary: string;
  status: "approved" | "rejected";
  comment: string | null;
}

export interface HeartbeatResponse {
  /** The task was cancelled: stop the agent and complete the execution. */
  cancel: boolean;
  leaseExpiresAt: string;
}

export interface ToolCheckRequest {
  tool: string;
  input: unknown;
  /** Set by the policy hook: the call carried the value of this secret (redacted from `input`). */
  containsSecret?: string | undefined;
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
  /**
   * The runner only merged the moved base branch in and did not run the agent:
   * once it validates, the task goes back to the merge queue without a new review.
   */
  revalidation?: boolean | undefined;
  /** The worktree's changes against the base branch after the run (spec §43 "Open diff"). */
  diff?: string | undefined;
}

/** A message a person sent to a task's agent (spec §43 "Send instruction"). */
export interface InstructionDto {
  id: string;
  taskId: string;
  text: string;
  author: string;
  createdAt: string;
  /** The execution it was given to; null until the agent receives it. */
  executionId: string | null;
}

export interface SendInstructionRequest {
  text: string;
  /** Stop a running agent now and resume it with the instruction (default true); otherwise it is given at the next run. */
  interrupt?: boolean | undefined;
}

export interface EventsPage {
  events: EventDto[];
  /** Pass as `after` to fetch the next page. */
  nextAfter: number;
}

/** A ratio with what it was computed from; value is null when nothing was measured. */
export interface MetricRate {
  value: number | null;
  numerator: number;
  denominator: number;
}

/**
 * Product success metrics (spec §64) over a time window, for a project or
 * everything the caller can see. Definitions: docs/adr/0030-success-metrics.md.
 */
export interface ProductMetrics {
  since: string;
  days: number;
  collaboration: { handoffSuccess: MetricRate; contextReuse: MetricRate; agentToAgentHandoff: MetricRate };
  engineering: {
    taskSuccess: MetricRate;
    validationPass: MetricRate;
    rework: MetricRate;
    reviewRejection: MetricRate;
    meanCompletionMs: number | null;
  };
  automation: { humanIntervention: MetricRate; autoResolution: MetricRate; autonomousCompletion: MetricRate };
  reliability: { failureRecovery: MetricRate; resumeSuccess: MetricRate; workspaceFailure: MetricRate };
  platform: {
    agentsIntegrated: number;
    runnersOnline: number;
    concurrentSessions: number;
    peakConcurrentSessions: number;
    projectsManaged: number;
    /** READY → ASSIGNED: how long ready work waits for the scheduler. */
    meanQueueWaitMs: number | null;
    /** Assigned → agent started on the runner (workspace preparation included). */
    meanDispatchMs: number | null;
  };
}
