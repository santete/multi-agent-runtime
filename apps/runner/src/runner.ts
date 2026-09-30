import { fileURLToPath } from "node:url";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentEvent,
  type AgentRunRequest,
  type ClaimResponse,
  HANDOFF_SCHEMA,
  toHandoff,
} from "@mar/core";
import { ControlPlaneClient, ControlPlaneError } from "./client.js";
import { type RunnerConfig, type RunnerConfigInput, createAdapter, runnerConfig } from "./config.js";
import { type ProcessOutcome, runAgentProcess } from "./process.js";
import { buildPrompt, contextFiles } from "./context.js";
import { runValidation } from "./validator.js";
import { WorktreeManager, commitAndPush } from "./worktree.js";

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
    return [...this.adapters].map(([id, adapter]) => ({ id, adapter: adapter.id, capabilities: adapter.capabilities }));
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
  async start(): Promise<void> {
    if (!this.runnerId) await this.register();
    while (!this.stopping) {
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
    const { execution, task, project } = claim;
    const log = { task: task.key, execution: execution.id, attempt: execution.attempt };
    const adapter = this.adapters.get(task.agent);
    if (!adapter) {
      // Should not happen: the control plane only hands out tasks for our agents.
      await this.fail(execution.id, `runner has no agent "${task.agent}"`);
      return;
    }

    let workspace;
    try {
      workspace = await this.worktrees.prepare(project, task.key);
    } catch (err) {
      this.log.error("workspace preparation failed", { ...log, error: String(err) });
      await this.fail(execution.id, `workspace preparation failed: ${String(err)}`);
      return;
    }

    // Resume only our own session: agent session state lives on this machine.
    const resumeSessionId =
      claim.resume && claim.resume.runnerId === this.runnerId && adapter.capabilities.resume
        ? claim.resume.sessionId
        : undefined;

    const request: AgentRunRequest = {
      workspace: workspace.path,
      prompt: buildPrompt(claim, Boolean(resumeSessionId)),
      objective: task.objective,
      permissionProfile: "edit",
      timeoutSeconds: this.config.timeoutSeconds,
      env: {
        MAR_CONTROL_PLANE_URL: this.client.baseUrl,
        MAR_EXECUTION_ID: execution.id,
        MAR_EXECUTION_TOKEN: claim.executionToken,
      },
      ...(resumeSessionId && { resumeSessionId }),
      ...(adapter.capabilities.structuredOutput && { outputSchema: HANDOFF_SCHEMA }),
      ...(this.config.policyHook &&
        adapter.capabilities.approval === "pre-tool-hook" && {
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
      const { outcome, restore } = await this.runAgent(claim, adapter, request, workspace.path, abort.signal);
      let after;
      try {
        after = await this.client.complete(execution.id, outcome);
      } catch (err) {
        // 409: the control plane already gave up on this execution (lease expired).
        if (err instanceof ControlPlaneError && err.status === 409) {
          this.log.error("execution was no longer active when the agent finished", { ...log, error: err.body });
          return;
        }
        throw err;
      }
      this.log.info("agent finished", { ...log, exitCode: outcome.exitCode, status: after.status });
      if (after.status !== "validating") return;

      const report = await runValidation(workspace.path, project.validation, abort.signal);
      const { deliver } = await this.client.validation(execution.id, report);
      this.log.info("validation finished", { ...log, passed: report.passed, deliver });
      if (!deliver) return;

      await this.deliver(claim, workspace, outcome, restore);
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
  ): Promise<{ outcome: ProcessOutcome; restore: string[] }> {
    const shipper = new EventShipper(this.client, claim.execution.id);
    let outcome: ProcessOutcome;
    let restore: string[] = [];
    try {
      const files = [...contextFiles(claim), ...(adapter.workspaceFiles?.(request) ?? [])];
      restore = (await this.worktrees.writeFiles(worktree, files)).modifiedTracked;
      if (restore.length) {
        shipper.push({ kind: "diagnostic", text: `runner merged its config into tracked files: ${restore.join(", ")}` });
      }
      outcome = await runAgentProcess(adapter.buildCommand(request), adapter.createParser(), {
        timeoutMs: this.config.timeoutSeconds * 1000,
        signal,
        onEvent: (e) => shipper.push(e),
      });
    } catch (err) {
      outcome = { exitCode: null, terminal: { kind: "failed", reason: `runner error: ${String(err)}` } };
      shipper.push(outcome.terminal);
    }
    try {
      await shipper.close();
    } catch (err) {
      this.log.error("some agent events could not be shipped", { execution: claim.execution.id, error: String(err) });
    }
    return { outcome, restore };
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
