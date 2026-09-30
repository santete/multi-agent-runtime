import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "@mar/control-plane";
import type { PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

// The planner reads the brief the runner wrote and proposes two dependent tasks
// for the worker agent it found there.
const PLANNER = `
const fs = require("fs");
const brief = fs.readFileSync(".orchestrator/context/PLAN.md", "utf8");
if (!brief.includes("Ship two files") || !brief.includes("\`worker\`")) process.exit(3);
console.log("Here is my plan:\\n" + JSON.stringify({
  summary: "a.txt first, then b.txt.",
  tasks: [
    { ref: "T2", title: "Write b", objective: "b.txt", agent: "worker", requires: [], dependsOn: ["T1"] },
    { ref: "T1", title: "Write a", objective: "a.txt", agent: "worker", requires: [], dependsOn: [] },
  ],
}));`;

// Writes the file named by its objective.
const WORKER = `require("fs").writeFileSync(process.argv[1], "ok\\n"); console.log("wrote " + process.argv[1]);`;

describe("assisted planning with real git", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;
  const provider: GitProvider = {
    async openPullRequest() {
      return { url: "local://pr/1", number: 1 };
    },
    async mergePullRequest(req) {
      await git(origin.path, "-c", "user.name=m", "-c", "user.email=m@x", "merge", "--no-ff", "--no-edit", req.head);
      return { status: "merged", sha: null };
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
  const state = async (id: string) => (await api<TaskDto>(`/tasks/${id}`)).state;

  it("plans, is approved, and runs the planned DAG", async () => {
    const project = await api<ProjectDto>("/projects", { key: "PL", name: "plan", repoUrl: origin.path });
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "plan-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: {
          planner: { adapter: "generic-cli", command: process.execPath, args: ["-e", PLANNER] },
          worker: { adapter: "generic-cli", command: process.execPath, args: ["-e", WORKER, "{objective}"] },
        },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();
    const plan = await api<PlanDto>(`/projects/${project.id}/plans`, { goal: "Ship two files", agent: "planner" });

    // 1. The planner proposes; nothing is created or pushed yet.
    expect(await runner.runOnce()).toBe(true);
    const proposed = await api<PlanDto>(`/plans/${plan.id}`);
    expect(proposed.status).toBe("proposed");
    expect(proposed.proposal?.tasks.map((t) => t.ref)).toEqual(["T1", "T2"]);

    // 2. A human approves: T1 is READY, T2 waits for it.
    const approved = await api<PlanDto>(`/plans/${plan.id}/approve`, {});
    const [t1, t2] = approved.createdTasks.map((t) => t.taskId);
    expect([await state(t1!), await state(t2!)]).toEqual(["READY", "CREATED"]);

    // 3. The DAG runs through review and the merge queue in order.
    for (const id of [t1!, t2!]) {
      expect(await runner.runOnce()).toBe(true);
      expect(await state(id)).toBe("REVIEW");
      await api(`/tasks/${id}/review`, { decision: "approve" });
      await store.processMergeQueue();
      expect(await state(id)).toBe("COMPLETED");
    }
    expect(existsSync(join(origin.path, "a.txt")) && existsSync(join(origin.path, "b.txt"))).toBe(true);
    // The planner's worktree delivered nothing.
    expect((await git(origin.path, "branch", "--list", "task/*")).split("\n").map((b) => b.trim().replace("* ", ""))).toEqual([
      "task/PL-2",
      "task/PL-3",
    ]);
  });
});
