import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "@mar/control-plane";
import type { ArtifactDto, EventsPage, ExecutionDto, ProjectDto, TaskDto, ValidationReport } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

// A stand-in agent: first attempt produces a draft only; once it sees the
// platform's REWORK.md it produces the file validation checks for.
const AGENT = `
const fs = require("fs");
if (!fs.existsSync(".orchestrator/context/TASK.md")) process.exit(3);
if (fs.existsSync(".orchestrator/context/REWORK.md")) {
  fs.writeFileSync("ok.txt", "fixed\\n");
  fs.writeFileSync("rework-seen.txt", fs.readFileSync(".orchestrator/context/REWORK.md", "utf8").split("\\n")[0]);
  console.log("fixed after rework");
} else {
  fs.writeFileSync("draft.txt", "draft\\n");
  console.log("draft only");
}`;

const VALIDATE = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;

/**
 * M3 exit criterion: a task that fails validation is reworked automatically
 * until it passes, then committed, pushed and delivered as a pull request.
 */
describe("M3: validation, rework and delivery", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;
  const opened: Array<{ head: string; body: string }> = [];
  const provider: GitProvider = {
    async openPullRequest(req) {
      opened.push(req);
      return { url: "https://github.com/o/r/pull/42", number: 42 };
    },
  };

  beforeAll(async () => {
    db = await createPgliteDb();
    await migrate(db);
    store = new Store(db, { gitProvider: provider });
    app = buildApp(store);
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    origin = await tempDir("origin");
    home = await tempDir("home");
    await createOriginRepo(origin.path);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await Promise.all([home.cleanup(), origin.cleanup()]);
  });

  const api = async <T>(path: string, body?: object): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    expect(res.ok).toBe(true);
    return (await res.json()) as T;
  };

  it("reworks a task until validation passes, then commits, pushes and opens a pull request", async () => {
    const project = await api<ProjectDto>("/projects", {
      key: "M3",
      name: "M3",
      repoUrl: origin.path,
      validation: [{ name: "has-ok-file", command: VALIDATE, timeoutSeconds: 60 }],
    });
    const task = await api<TaskDto>(`/projects/${project.id}/tasks`, {
      title: "Produce ok file",
      objective: "Create ok.txt",
      agent: "fake",
    });
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "m3-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: { fake: { adapter: "generic-cli", command: process.execPath, args: ["-e", AGENT] } },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();

    // Attempt 1: validation fails -> REWORK -> requeued.
    expect(await runner.runOnce()).toBe(true);
    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("REWORK");
    expect(await store.sweep()).toMatchObject({ requeued: 1 });

    // Attempt 2: the agent sees the failure, fixes it, validation passes, delivered.
    expect(await runner.runOnce()).toBe(true);
    const done = await api<TaskDto>(`/tasks/${task.id}`);
    expect(done).toMatchObject({ state: "REVIEW", pullRequestUrl: "https://github.com/o/r/pull/42" });

    const executions = await api<ExecutionDto[]>(`/tasks/${task.id}/executions`);
    expect(executions.map((e) => e.status)).toEqual(["failed", "succeeded"]);

    const validations = (await api<ArtifactDto[]>(`/tasks/${task.id}/artifacts`))
      .filter((a) => a.type === "validation_result")
      .map((a) => a.content as unknown as ValidationReport);
    expect(validations.map((v) => v.passed)).toEqual([false, true]);
    expect(validations[0]!.steps[0]).toMatchObject({ name: "has-ok-file", passed: false, exitCode: 1 });

    // The pushed branch holds the work, not the platform's context files.
    const worktree = executions[1]!.workspace!;
    expect(readFileSync(join(worktree, "rework-seen.txt"), "utf8")).toBe("# Rework after attempt 1");
    const files = (await git(origin.path, "ls-tree", "-r", "--name-only", "task/M3-1")).split("\n");
    expect(files.sort()).toEqual(["README.md", "draft.txt", "ok.txt", "rework-seen.txt"]);
    expect(await git(origin.path, "log", "-1", "--format=%an|%s", "task/M3-1")).toBe(
      "multi-agent-runtime|M3-1: Produce ok file",
    );
    expect(await git(worktree, "status", "--porcelain")).toBe("");

    expect(opened).toHaveLength(1);
    expect(opened[0]!.head).toBe("task/M3-1");
    expect(opened[0]!.body).toContain("✅ pass");
    expect(opened[0]!.body).toContain("`ok.txt`");

    const timeline = (await api<EventsPage>(`/tasks/${task.id}/events?limit=1000`)).events
      .filter((e) => e.type === "TaskStateChanged")
      .map((e) => e.payload.to);
    expect(timeline).toEqual([
      "READY",
      "ASSIGNED",
      "RUNNING",
      "VALIDATING",
      "REWORK",
      "READY",
      "ASSIGNED",
      "RUNNING",
      "VALIDATING",
      "REVIEW",
    ]);
  });
});
