import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "@mar/control-plane";
import type { EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerConfigInput } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { createOriginRepo, tempDir } from "./helpers.js";

/**
 * M2 behaviour against a real control plane:
 * policy hook chain (Claude-compatible agent), cancellation via heartbeat,
 * and resuming the agent session after a runner disappears.
 */
describe.runIf(process.platform === "win32")("M2: policy hook, cancel, lease + resume", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;
  let bin: Awaited<ReturnType<typeof tempDir>>;
  let claudeShim: string;
  const quiet = { info: () => undefined, error: () => undefined };

  beforeAll(async () => {
    db = await createPgliteDb();
    await migrate(db);
    store = new Store(db, { leaseSeconds: 1 });
    app = buildApp(store);
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    origin = await tempDir("origin");
    home = await tempDir("home");
    bin = await tempDir("bin");
    await createOriginRepo(origin.path);
    // An npm-style shim, so the runner's shim unwrapping is exercised too.
    await copyFile(new URL("./fixtures/fake-claude.mjs", import.meta.url), join(bin.path, "fake-claude.mjs"));
    claudeShim = join(bin.path, "claude.cmd");
    await writeFile(claudeShim, '@ECHO off\r\n"%dp0%\\fake-claude.mjs" %*\r\n');
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await Promise.all([home.cleanup(), origin.cleanup(), bin.cleanup()]);
  });

  const api = async <T>(path: string, body?: object): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    expect(res.ok).toBe(true);
    return (await res.json()) as T;
  };

  const config = (overrides: Partial<RunnerConfigInput> = {}): RunnerConfigInput => ({
    controlPlaneUrl: baseUrl,
    name: "e2e-box",
    home: home.path,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 100,
    maxConcurrent: 1,
    timeoutSeconds: 60,
    agents: {
      claude: { adapter: "claude-code", executable: claudeShim },
      sleeper: { adapter: "generic-cli", command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
    },
    ...overrides,
  });

  async function newTask(key: string, objective: string, agent = "claude") {
    const project = await api<ProjectDto>("/projects", { key, name: key, repoUrl: origin.path });
    return api<TaskDto>(`/projects/${project.id}/tasks`, { title: objective, objective, agent });
  }

  async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = await fn();
      if (done(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const toolChecks = async (taskId: string) =>
    (await api<EventsPage>(`/tasks/${taskId}/events`)).events
      .filter((e) => e.type === "ToolCallChecked")
      .map((e) => ({ decision: e.payload.decision, risk: e.payload.risk }));

  it("allows a safe command through the injected hook", async () => {
    const task = await newTask("OK", "run: git status --short");
    const runner = new Runner(config(), quiet);
    await runner.register();
    expect(await runner.runOnce()).toBe(true);

    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("VALIDATING");
    expect(await toolChecks(task.id)).toEqual([{ decision: "allow", risk: "LOW" }]);
    const [execution] = await api<ExecutionDto[]>(`/tasks/${task.id}/executions`);
    expect(execution).toMatchObject({ status: "succeeded", sessionId: "fake-session-1" });
  });

  it("denies a push, audits it and parks the task for a human", async () => {
    const task = await newTask("PUSH", "run: git push origin main");
    const runner = new Runner(config(), quiet);
    await runner.register();
    expect(await runner.runOnce()).toBe(true);

    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("WAITING_FOR_HUMAN");
    expect(await toolChecks(task.id)).toEqual([{ decision: "deny", risk: "CRITICAL" }]);
    const [execution] = await api<ExecutionDto[]>(`/tasks/${task.id}/executions`);
    expect(execution!.status).toBe("needs_approval");
  });

  it("stops a running agent when its task is cancelled", async () => {
    const task = await newTask("CXL", "sleep", "sleeper");
    const runner = new Runner(config(), quiet);
    const loop = runner.start();
    await waitFor(() => api<TaskDto>(`/tasks/${task.id}`), (t) => t.state === "RUNNING", "RUNNING");

    const started = Date.now();
    await api(`/tasks/${task.id}/cancel`, {});
    const [execution] = await waitFor(
      () => api<ExecutionDto[]>(`/tasks/${task.id}/executions`),
      (e) => e[0]?.status === "cancelled",
      "cancelled execution",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(execution!.result).toMatchObject({ kind: "failed", reason: "cancelled" });
    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("CANCELLED");
    runner.stop();
    await loop;
  });

  it("resumes the agent session after the runner vanished mid-run", async () => {
    const task = await newTask("RES", "run: git status");

    // Runner instance #1 claims the task, starts the agent, then "crashes":
    // no more heartbeats, no completion.
    const crashed = new Runner(config(), quiet);
    const runnerId = await crashed.register();
    const claim = (await crashed.client.claim(runnerId))!;
    await crashed.client.start(claim.execution.id, join(home.path, "worktrees", "RES-1"), "task/RES-1");
    await crashed.client.appendEvents(claim.execution.id, [{ kind: "session_started", sessionId: "sess-before-crash" }]);

    await new Promise((r) => setTimeout(r, 1200));
    expect(await store.sweep()).toMatchObject({ lost: 1, requeued: 1 });

    // Runner comes back (same name -> same id) and resumes its own session.
    const restarted = new Runner(config(), quiet);
    expect(await restarted.register()).toBe(runnerId);
    expect(await restarted.runOnce()).toBe(true);

    const executions = await api<ExecutionDto[]>(`/tasks/${task.id}/executions`);
    expect(executions.map((e) => e.status)).toEqual(["lost", "succeeded"]);
    expect(executions[1]).toMatchObject({ attempt: 2, sessionId: "sess-before-crash" });
    expect(executions[1]!.result).toMatchObject({ result: "resumed sess-before-crash" });
    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("VALIDATING");
  });
});
