import { fileURLToPath } from "node:url";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentEvent,
  type AgentRunRequest,
  type ClaimResponse,
  HANDOFF_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  toHandoff,
} from "@mar/core";
import { activeTraceparent, meter, SpanKind, SpanStatusCode, withSpan } from "@mar/telemetry";
import { ControlPlaneClient, ControlPlaneError } from "./client.js";
import { type RunnerConfig, type RunnerConfigInput, createAdapter, runnerConfig } from "./config.js";
import { type ProcessOutcome, runAgentProcess } from "./process.js";
import {
  type ContextExtras,
  buildPlanPrompt,
  buildPrompt,
  buildReviewPrompt,
  contextFiles,
  knowledgeFiles,
  planFiles,
  reviewFiles,
} from "./context.js";
import { runValidation } from "./validator.js";
import { WorktreeManager, commitAndPush, mergeBase } from "./worktree.js";

export interface RunnerLogger {
  info(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

const consoleLogger: RunnerLogger = {
  info: (msg, data) => console.log(`[runner] ${msg}`, data ?? ""),
  error: (msg, data) => console.error(`[runner] ${msg}`, data ?? ""),
};

export const POLICY_HOOK_SCRIPT = fileURLToPath(new URL("../hook/mar-policy-hook.mjs", import.meta.url));

const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH_SIZE = 100;

/** Batches agent events and ships them to the control plane in order. */
class EventShipper {
  private buffer: AgentEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;
  private error: unknown;

  constructor(
    private readonly client: ControlPlaneClient,
    private readonly executionId: string,
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  push(event: AgentEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) void this.flush();
  }

  flush(): Promise<void> {
    if (!this.buffer.length) return this.chain;
    const batch = this.buffer;
    this.buffer = [];
    this.chain = this.chain.then(() =>
      this.client.appendEvents(this.executionId, batch).catch((err) => {
        this.error ??= err;
      }),
    );
    return this.chain;
  }

  /** Flushes everything; rethrows the first shipping error. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    if (this.error) throw this.error;
  }
}

export class Runner {
  readonly config: RunnerConfig;
  readonly client: ControlPlaneClient;
  readonly worktrees: WorktreeManager;
  private readonly adapters = new Map<string, AgentAdapter>();
  private runnerId: string | undefined;
  private readonly active = new Set<Promise<void>>();
  /** Keys of tasks currently executing on this runner (their worktrees are in use). */
  private readonly working = new Set<string>();
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    config: RunnerConfigInput,
    private readonly log: RunnerLogger = consoleLogger,
  ) {
    this.config = runnerConfig.parse(config);
    this.client = new ControlPlaneClient(
      this.config.controlPlaneUrl.replace(/\/$/, ""),
      this.config.apiToken ?? process.env.MAR_API_TOKEN,
    );
    this.worktrees = new WorktreeManager(this.config.home);
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      this.adapters.set(agentId, createAdapter(agentConfig));
    }
  }

  get agents(): AgentDescriptor[] {
    return [...this.adapters].map(([id, adapter]) => ({
      id,
      adapter: adapter.id,
      capabilities: adapter.capabilities,
      skills: this.config.agents[id]!.skills,
      cost: this.config.agents[id]!.cost,
      ...(this.config.agents[id]!.pricing && { pricing: this.config.agents[id]!.pricing }),
      ...(this.config.agents[id]!.maxConcurrent && { maxConcurrent: this.config.agents[id]!.maxConcurrent }),
    }));
  }

  async register(): Promise<string> {
    this.runnerId = await this.client.register(this.config.name, this.agents);
    this.log.info("registered", { runnerId: this.runnerId, agents: [...this.adapters.keys()] });
    return this.runnerId;
  }

  /** Claims and fully executes at most one task. Returns false if there was nothing to do. */
  async runOnce(): Promise<boolean> {
    const claim = await this.claim();
    if (!claim) return false;
    await this.execute(claim);
    return true;
  }

  /** Poll loop honouring maxConcurrent. Resolves after stop() once active work drains. */
  /**
   * Removes worktrees (and local branches) of tasks the control plane reports
   * as finished. Worktrees of tasks being worked on here are never touched.
   * Returns the removed task keys.
   */
  async collectGarbage(): Promise<string[]> {
    if (!this.runnerId) throw new Error("runner is not registered");
    const keys = (await this.worktrees.listTaskKeys()).filter((k) => !this.working.has(k));
    if (!keys.length) return [];
    const finished = await this.client.finishedTasks(this.runnerId, keys);
    const removed: string[] = [];
    for (const key of finished) {
      try {
        await this.worktrees.removeByTaskKey(key);
        removed.push(key);
      } catch (err) {
        this.log.error("worktree cleanup failed", { task: key, error: String(err) });
      }
    }
    if (removed.length) this.log.info("removed worktrees of finished tasks", { tasks: removed });
    return removed;
  }

  async start(): Promise<void> {
    if (!this.runnerId) await this.register();
    let lastGc = 0;
    while (!this.stopping) {
      if (Date.now() - lastGc >= this.config.gcIntervalMs) {
        lastGc = Date.now();
        await this.collectGarbage().catch((err) => this.log.error("garbage collection failed", { error: String(err) }));
      }
      if (this.active.size < this.config.maxConcurrent) {
        let claim: ClaimResponse | undefined;
        try {
          claim = await this.claim();
        } catch (err) {
          this.log.error("claim failed", { error: String(err) });
        }
        if (claim) {
          const job = this.execute(claim)
            .catch((err) => this.log.error("execution crashed", { error: String(err) }))
            .finally(() => {
              this.active.delete(job);
              this.wake?.();
            });
          this.active.add(job);
          continue;
        }
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.config.pollIntervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    await Promise.all(this.active);
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private claim(): Promise<ClaimResponse | undefined> {
    if (!this.runnerId) throw new Error("runner is not registered");
    return this.client.claim(this.runnerId);
  }

  private async fail(executionId: string, reason: string): Promise<void> {
    await this.client.complete(executionId, { exitCode: null, terminal: { kind: "failed", reason } });
  }


  private async execute(claim: ClaimResponse): Promise<void> {
    this.working.add(claim.task.key);
    try {
      await this.executeClaim(claim);
    } finally {
      this.working.delete(claim.task.key);
    }
  }

  /** One trace per execution (spec §41): workspace, agent, validation and delivery are its spans. */
  private executeClaim(claim: ClaimResponse): Promise<void> {
    const { execution, task, project } = claim;
    const started = Date.now();
    return withSpan(
      `execution ${task.key}`,
      {
        "mar.project.key": project.key,
        "mar.task.key": task.key,
        "mar.task.id": task.id,
        "mar.task.kind": task.kind,
        "mar.execution.id": execution.id,
        "mar.execution.attempt": execution.attempt,
        "mar.agent": task.agent,
        ...(claim.rework && { "mar.rework": claim.rework.kind }),
      },
      async (span) => {
        const status = await this.runClaim(claim);
        span.setAttribute("mar.execution.outcome", status);
        const labels = { "mar.agent": task.agent, "mar.execution.outcome": status };
        executionsCounter().add(1, labels);
        executionDuration().record((Date.now() - started) / 1000, labels);
      },
      { root: true, kind: SpanKind.CONSUMER },
    );
  }

  /**
   * Prepares the worktree; a broken one is thrown away and recreated, then the
   * clone too (spec §46: "workspace lỗi"). Work already pushed is not lost:
   * a fresh worktree continues from the pushed task branch.
   */
  private async prepareWorkspace(claim: ClaimResponse) {
    const { project, task } = claim;
    for (const repair of [undefined, "worktree", "clone"] as const) {
      try {
        if (repair) {
          this.log.error("workspace broken, recreating it", { task: task.key, repair });
          await this.worktrees.discard(project, task.key, repair === "clone");
        }
        return await this.worktrees.prepare(project, task.key, claim.review?.branch);
      } catch (err) {
        if (repair === "clone") throw err;
        this.log.error("workspace preparation failed", { task: task.key, error: String(err) });
      }
    }
    throw new Error("unreachable");
  }

  private async runClaim(claim: ClaimResponse): Promise<string> {
    const { execution, task, project } = claim;
    const log = { task: task.key, execution: execution.id, attempt: execution.attempt };
    const adapter = this.adapters.get(task.agent);
    if (!adapter) {
      // Should not happen: the control plane only hands out tasks for our agents.
      await this.fail(execution.id, `runner has no agent "${task.agent}"`);
      return "failed";
    }

    let workspace;
    let reviewDiff = "";
    try {
      // A review task checks out the reviewed task's delivered branch.
      workspace = await withSpan("workspace.prepare", {}, async () => {
        const w = await this.prepareWorkspace(claim);
        if (claim.review) reviewDiff = await this.worktrees.diffAgainst(w.path, claim.review.baseBranch);
        return w;
      });
    } catch (err) {
      this.log.error("workspace preparation failed", { ...log, error: String(err) });
      await this.fail(execution.id, `workspace preparation failed: ${String(err)}`);
      return "failed";
    }

    // Resume only our own session: agent session state lives on this machine.
    const resumeSessionId =
      claim.resume && claim.resume.runnerId === this.runnerId && adapter.capabilities.resume
        ? claim.resume.sessionId
        : undefined;

    const request: AgentRunRequest = {
      workspace: workspace.path,
      prompt: claim.review
        ? buildReviewPrompt(claim.review, claim)
        : claim.plan
          ? buildPlanPrompt(claim.plan, adapter.capabilities.structuredOutput, claim)
          : buildPrompt(claim, Boolean(resumeSessionId)),
      objective: task.objective,
      // Reviewers and planners only read: nothing of their worktree is ever delivered.
      permissionProfile: claim.review || claim.plan ? "read-only" : "edit",
      timeoutSeconds: this.config.timeoutSeconds,
      env: {
        MAR_CONTROL_PLANE_URL: this.client.baseUrl,
        MAR_EXECUTION_ID: execution.id,
        MAR_EXECUTION_TOKEN: claim.executionToken,
      },
      ...(resumeSessionId && { resumeSessionId }),
      ...(adapter.capabilities.structuredOutput && { outputSchema: claim.review ? REVIEW_SCHEMA : claim.plan ? PLAN_SCHEMA : HANDOFF_SCHEMA }),
      ...(this.config.policyHook &&
        // Also for sandboxed agents: their hook works wherever the CLI fires it.
        (adapter.capabilities.approval === "pre-tool-hook" || adapter.capabilities.approval === "sandbox") && {
          policyHook: { command: process.execPath, args: [POLICY_HOOK_SCRIPT] },
        }),
    };

    await this.client.start(execution.id, workspace.path, workspace.branch);
    this.log.info("execution started", { ...log, agent: task.agent, workspace: workspace.path, resumeSessionId });

    // The lease covers the whole execution: agent run, validation and delivery.
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      this.client
        .heartbeat(execution.id)
        .then((hb) => {
          if (hb.cancel && !abort.signal.aborted) {
            this.log.info("cancel requested", log);
            abort.abort();
          }
        })
        .catch((err) => this.log.error("heartbeat failed", { ...log, error: String(err) }));
    }, this.config.heartbeatIntervalMs);

    try {
      const { outcome, restore, revalidation } = await this.runAgent(claim, adapter, request, workspace.path, abort.signal, reviewDiff);
      let after;
      try {
        after = await this.client.complete(execution.id, { ...outcome, ...(revalidation && { revalidation }) });
      } catch (err) {
        // 409: the control plane already gave up on this execution (lease expired).
        if (err instanceof ControlPlaneError && err.status === 409) {
          this.log.error("execution was no longer active when the agent finished", { ...log, error: err.body });
          return "lost";
        }
        throw err;
      }
      this.log.info("agent finished", { ...log, exitCode: outcome.exitCode, status: after.status });
      if (after.status !== "validating") return after.status;

      const report = await withSpan("validation", { "mar.validation.steps": project.validation.length }, async (span) => {
        const r = await runValidation(workspace.path, project.validation, abort.signal, {
          sandbox: project.validationSandbox,
          containerRuntime: this.config.containerRuntime,
        });
        span.setAttribute("mar.validation.passed", r.passed);
        return r;
      });
      const { deliver } = await this.client.validation(execution.id, report);
      this.log.info("validation finished", { ...log, passed: report.passed, deliver });
      if (!deliver) return report.passed ? "validated" : "validation_failed";

      await withSpan("delivery", { "mar.branch": workspace.branch }, () => this.deliver(claim, workspace, outcome, restore));
      return "delivered";
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runAgent(
    claim: ClaimResponse,
    adapter: AgentAdapter,
    request: AgentRunRequest,
    worktree: string,
    signal: AbortSignal,
    reviewDiff = "",
  ): Promise<{ outcome: ProcessOutcome; restore: string[]; revalidation?: boolean }> {
    const shipper = new EventShipper(this.client, claim.execution.id);
    let outcome: ProcessOutcome;
    let restore: string[] = [];
    let revalidation = false;
    try {
      // Rework after a merge conflict or a moved base: bring the latest base
      // branch in first; the agent resolves whatever conflicts remain.
      let extras: ContextExtras = {};
      const kind = claim.rework?.kind;
      const base = kind === "merge_conflict" || kind === "base_changed" ? claim.rework?.baseBranch : undefined;
      if (base) {
        const { conflicts } = await mergeBase(worktree, base, this.config.gitAuthor);
        extras = { conflicts };
        shipper.push({
          kind: "diagnostic",
          text: conflicts.length
            ? `runner merged origin/${base}: conflicts in ${conflicts.join(", ")}`
            : `runner merged origin/${base} cleanly`,
        });
      }
      // A moved base that merges cleanly needs no agent: only the validation runs again.
      if (kind === "base_changed" && !extras.conflicts?.length) {
        revalidation = true;
        const summary = `Merged the latest ${base} into the branch; re-validating without agent changes.`;
        shipper.push({ kind: "diagnostic", text: summary });
        outcome = {
          exitCode: 0,
          terminal: {
            kind: "completed",
            sessionId: "",
            success: true,
            deniedActions: [],
            result: { summary, changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: [] },
          },
        };
        await shipper.close().catch(() => undefined);
        return { outcome, restore, revalidation };
      }
      const context = claim.review
        ? reviewFiles(claim.review, reviewDiff)
        : claim.plan
          ? planFiles(claim.plan)
          : contextFiles(claim, extras);
      const files = [...context, ...knowledgeFiles(claim), ...(adapter.workspaceFiles?.(request) ?? [])];
      restore = (await this.worktrees.writeFiles(worktree, files)).modifiedTracked;
      if (restore.length) {
        shipper.push({ kind: "diagnostic", text: `runner merged its config into tracked files: ${restore.join(", ")}` });
      }
      outcome = await withSpan(
        "agent.run",
        { "mar.agent": claim.task.agent, "mar.adapter": adapter.id, "mar.agent.resume": Boolean(request.resumeSessionId) },
        async (span) => {
          // The agent's policy hook sends this back, so tool checks join the trace.
          const traceparent = activeTraceparent();
          const command = adapter.buildCommand(traceparent ? { ...request, env: { ...request.env, TRACEPARENT: traceparent } } : request);
          const result = await runAgentProcess(command, adapter.createParser(), {
            timeoutMs: this.config.timeoutSeconds * 1000,
            signal,
            onEvent: (e) => shipper.push(e),
          });
          recordAgentOutcome(span, claim.task.agent, result);
          return result;
        },
      );
    } catch (err) {
      outcome = { exitCode: null, terminal: { kind: "failed", reason: `runner error: ${String(err)}` } };
      shipper.push(outcome.terminal);
    }
    try {
      await shipper.close();
    } catch (err) {
      this.log.error("some agent events could not be shipped", { execution: claim.execution.id, error: String(err) });
    }
    return { outcome, restore, ...(revalidation && { revalidation }) };
  }

  /** Commits and pushes the validated work, then asks the control plane to open the pull request. */
  private async deliver(
    { execution, task }: ClaimResponse,
    workspace: { path: string; branch: string },
    outcome: ProcessOutcome,
    restore: string[],
  ): Promise<void> {
    const log = { task: task.key, execution: execution.id };
    const summary = outcome.terminal.kind === "completed" ? toHandoff(outcome.terminal.result).summary : "";
    let commit;
    try {
      commit = await commitAndPush(workspace.path, {
        branch: workspace.branch,
        author: this.config.gitAuthor,
        restore,
        message: `${task.key}: ${task.title}\n\n${summary}\n\nAgent: ${task.agent}\nExecution: ${execution.id}`.trim(),
      });
    } catch (err) {
      this.log.error("delivery failed", { ...log, error: String(err) });
      await this.client.delivery(execution.id, {
        branch: workspace.branch,
        commitSha: null,
        changedFiles: [],
        error: String(err).slice(0, 4000),
      });
      return;
    }
    const { pullRequest } = await this.client.delivery(execution.id, { branch: workspace.branch, ...commit });
    this.log.info("delivered", { ...log, commit: commit.commitSha, pullRequest: pullRequest?.url ?? null });
  }
}

// ---- telemetry --------------------------------------------------------------

const executionsCounter = () => meter().createCounter("mar.executions", { description: "Executions run, by agent and outcome" });
const executionDuration = () =>
  meter().createHistogram("mar.execution.duration", { unit: "s", description: "Execution time from claim to delivery" });
const tokensCounter = () => meter().createCounter("mar.agent.tokens", { description: "Tokens used by agents" });
const costCounter = () => meter().createCounter("mar.agent.cost", { unit: "USD", description: "Reported agent cost" });

/** Agent results on the span (GenAI conventions for tokens) and in the metrics. */
function recordAgentOutcome(span: import("@mar/telemetry").Span, agent: string, outcome: ProcessOutcome): void {
  const t = outcome.terminal;
  span.setAttributes({ "mar.agent.result": t.kind, "process.exit.code": outcome.exitCode ?? -1 });
  if (t.kind === "failed") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: t.reason.slice(0, 200) });
    return;
  }
  span.setAttributes({ "mar.agent.success": t.success, "mar.agent.denied_actions": t.deniedActions.length });
  if (t.usage) {
    span.setAttributes({ "gen_ai.usage.input_tokens": t.usage.inputTokens ?? 0, "gen_ai.usage.output_tokens": t.usage.outputTokens ?? 0 });
    tokensCounter().add(t.usage.inputTokens ?? 0, { "mar.agent": agent, "gen_ai.token.type": "input" });
    tokensCounter().add(t.usage.outputTokens ?? 0, { "mar.agent": agent, "gen_ai.token.type": "output" });
  }
  if (t.costUsd !== undefined) {
    span.setAttribute("mar.agent.cost_usd", t.costUsd);
    costCounter().add(t.costUsd, { "mar.agent": agent });
  }
}
