import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "@mar/control-plane";
import type { EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

/**
 * M1 exit criterion: a task created through the API is executed by a runner
 * in its own git worktree, and its log and events are visible through the API.
 */
describe("M1 walking skeleton (control plane + runner + generic CLI agent)", () => {
  let db: Db;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;

  beforeAll(async () => {
    db = await createPgliteDb();
    await migrate(db);
    app = buildApp(new Store(db));
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    origin = await tempDir("origin");
    home = await tempDir("home");
    await createOriginRepo(origin.path);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await home.cleanup();
    await origin.cleanup();
  });

  const api = async <T>(path: string, body?: object): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    expect(res.ok).toBe(true);
    return (await res.json()) as T;
  };

  it("executes a task in an isolated worktree and records the run", async () => {
    const project = await api<ProjectDto>("/projects", { key: "DEMO", name: "Demo", repoUrl: origin.path });
    // The "agent" is a node script configured on the runner; the task objective is its prompt.
    const task = await api<TaskDto>(`/projects/${project.id}/tasks`, {
      title: "Write a note",
      objective: "refund-notes.md",
      agent: "node-writer",
    });

    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "test-runner",
        home: home.path,
        pollIntervalMs: 50,
        maxConcurrent: 1,
        timeoutSeconds: 60,
        agents: {
          "node-writer": {
            adapter: "generic-cli",
            command: process.execPath,
            args: [
              "-e",
              "const f = process.argv[1]; require('fs').writeFileSync(f, 'idempotency matters\\n'); console.log('wrote ' + f); console.log('done');",
              "{prompt}",
            ],
          },
        },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();
    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(false);

    // Task reached the validation gate (validation itself arrives in M3).
    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("VALIDATING");

    // The change lives only in the task worktree, on the task branch.
    const [execution] = await api<ExecutionDto[]>(`/tasks/${task.id}/executions`);
    expect(execution).toMatchObject({ status: "succeeded", exitCode: 0, branch: "task/DEMO-1" });
    const worktree = execution!.workspace!;
    expect(readFileSync(join(worktree, "refund-notes.md"), "utf8")).toBe("idempotency matters\n");
    expect(await git(worktree, "branch", "--show-current")).toBe("task/DEMO-1");
    expect(existsSync(join(origin.path, "refund-notes.md"))).toBe(false);

    // Execution log and task timeline are visible through the API.
    const log = (await api<EventsPage>(`/executions/${execution!.id}/events`)).events;
    const messages = log.filter((e) => e.type === "AgentEvent" && e.payload.kind === "message").map((e) => e.payload.text);
    expect(messages).toEqual(["wrote refund-notes.md", "done"]);

    const timeline = (await api<EventsPage>(`/tasks/${task.id}/events`)).events
      .filter((e) => e.type === "TaskStateChanged")
      .map((e) => e.payload.to);
    expect(timeline).toEqual(["READY", "ASSIGNED", "RUNNING", "VALIDATING"]);
  });

  it("runs tasks concurrently through the poll loop", async () => {
    const project = await api<ProjectDto>("/projects", { key: "PAR", name: "Parallel", repoUrl: origin.path });
    const tasks = await Promise.all(
      [1, 2, 3].map((i) =>
        api<TaskDto>(`/projects/${project.id}/tasks`, { title: `t${i}`, objective: `${i}`, agent: "sleeper" }),
      ),
    );
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "loop-runner",
        home: home.path,
        pollIntervalMs: 50,
        maxConcurrent: 3,
        timeoutSeconds: 60,
        agents: {
          sleeper: {
            adapter: "generic-cli",
            command: process.execPath,
            args: ["-e", "setTimeout(() => console.log('slept'), 300)"],
          },
        },
      },
      { info: () => undefined, error: () => undefined },
    );
    const loop = runner.start();

    const waitForAll = async () => {
      for (let i = 0; i < 200; i++) {
        const states = await Promise.all(tasks.map((t) => api<TaskDto>(`/tasks/${t.id}`).then((x) => x.state)));
        if (states.every((s) => s === "VALIDATING")) return states;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("tasks did not finish");
    };
    expect(await waitForAll()).toEqual(["VALIDATING", "VALIDATING", "VALIDATING"]);
    runner.stop();
    await loop;
  });
});
