import type { AgentAdapter, AgentEvent, ClaimResponse } from "@mar/core";
import { ControlPlaneClient } from "./client.js";
import { type RunnerConfig, createAdapter } from "./config.js";
import { runAgentProcess } from "./process.js";
import { WorktreeManager } from "./worktree.js";

export interface RunnerLogger {
  info(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

const consoleLogger: RunnerLogger = {
  info: (msg, data) => console.log(`[runner] ${msg}`, data ?? ""),
  error: (msg, data) => console.error(`[runner] ${msg}`, data ?? ""),
};

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
  readonly client: ControlPlaneClient;
  readonly worktrees: WorktreeManager;
  private readonly adapters = new Map<string, AgentAdapter>();
  private runnerId: string | undefined;
  private readonly active = new Set<Promise<void>>();
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly config: RunnerConfig,
    private readonly log: RunnerLogger = consoleLogger,
  ) {
    this.client = new ControlPlaneClient(config.controlPlaneUrl.replace(/\/$/, ""));
    this.worktrees = new WorktreeManager(config.home);
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      this.adapters.set(agentId, createAdapter(agentConfig));
    }
  }

  async register(): Promise<string> {
    this.runnerId = await this.client.register(this.config.name, [...this.adapters.keys()]);
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
          const job = this.execute(claim).finally(() => {
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

  private async execute({ execution, task, project }: ClaimResponse): Promise<void> {
    const log = { task: task.key, execution: execution.id, attempt: execution.attempt };
    const adapter = this.adapters.get(task.agent);
    if (!adapter) {
      // Should not happen: the control plane only hands out tasks for our agents.
      await this.client.complete(execution.id, {
        exitCode: null,
        terminal: { kind: "failed", reason: `runner has no agent "${task.agent}"` },
      });
      return;
    }

    let workspace;
    try {
      workspace = await this.worktrees.prepare(project, task.key);
    } catch (err) {
      this.log.error("workspace preparation failed", { ...log, error: String(err) });
      await this.client.complete(execution.id, {
        exitCode: null,
        terminal: { kind: "failed", reason: `workspace preparation failed: ${String(err)}` },
      });
      return;
    }

    await this.client.start(execution.id, workspace.path, workspace.branch);
    this.log.info("execution started", { ...log, agent: task.agent, workspace: workspace.path });

    const shipper = new EventShipper(this.client, execution.id);
    const outcome = await runAgentProcess(
      adapter.buildCommand({
        workspace: workspace.path,
        prompt: task.objective,
        permissionProfile: "edit",
        timeoutSeconds: this.config.timeoutSeconds,
      }),
      adapter.createParser(),
      { timeoutMs: this.config.timeoutSeconds * 1000, onEvent: (e) => shipper.push(e) },
    );
    try {
      await shipper.close();
    } catch (err) {
      this.log.error("some agent events could not be shipped", { ...log, error: String(err) });
    }

    await this.client.complete(execution.id, outcome);
    this.log.info("execution finished", { ...log, exitCode: outcome.exitCode, terminal: outcome.terminal.kind });
  }
}
