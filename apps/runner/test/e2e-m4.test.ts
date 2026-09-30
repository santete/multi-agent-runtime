import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "@mar/control-plane";
import type { EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

// Git may check files out with CRLF on Windows.
const readText = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// Stand-in agent; the task objective selects its behaviour.
const AGENT = `
const fs = require("fs");
const mode = process.argv[1];
const readme = () => fs.readFileSync("README.md", "utf8");
if (mode === "owner") fs.writeFileSync("README.md", "# sample\\nowner: team-a\\n");
if (mode === "reviewer") {
  if (fs.existsSync(".orchestrator/context/REWORK.md") && readme().includes("<<<<<<<")) {
    fs.writeFileSync("README.md", "# sample\\nowner: team-a\\nreviewer: team-b\\n"); // conflict resolved
    console.log("resolved conflict");
  } else {
    fs.writeFileSync("README.md", "# sample\\nreviewer: team-b\\n");
  }
}
if (mode === "check") {
  const ok = readme().includes("team-a") && readme().includes("team-b") &&
    fs.existsSync(".orchestrator/context/DEPENDENCIES.md");
  if (!ok) process.exit(1);
  fs.writeFileSync("summary.txt", "both changes present\\n");
}`;

/**
 * M4 exit criterion (against real git): parallel branches of a DAG, a merge
 * conflict resolved through rework, and a dependent task that only starts
 * once both of its dependencies are merged.
 */
describe("M4: DAG, merge queue and conflict rework", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;

  // Merges task branches into the local origin's main, like GitHub would.
  const prs = new Map<string, number>();
  const provider: GitProvider = {
    async openPullRequest(req) {
      if (!prs.has(req.head)) prs.set(req.head, prs.size + 1);
      return { url: `local://pr/${prs.get(req.head)}`, number: prs.get(req.head)! };
    },
    async mergePullRequest(req) {
      try {
        await git(origin.path, "-c", "user.name=merger", "-c", "user.email=m@x", "merge", "--no-ff", "--no-edit", req.head);
        return { status: "merged", sha: await git(origin.path, "rev-parse", "HEAD") };
      } catch {
        await git(origin.path, "merge", "--abort");
        return { status: "conflict", message: `${req.head} conflicts with main` };
      }
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
  const state = async (t: TaskDto) => (await api<TaskDto>(`/tasks/${t.id}`)).state;
  const approve = (t: TaskDto) => api<TaskDto>(`/tasks/${t.id}/review`, { decision: "approve" });

  it("runs the DAG to completion", async () => {
    const project = await api<ProjectDto>("/projects", { key: "M4", name: "M4", repoUrl: origin.path });
    const newTask = (title: string, objective: string, dependsOn?: string[]) =>
      api<TaskDto>(`/projects/${project.id}/tasks`, { title, objective, agent: "fake", ...(dependsOn && { dependsOn }) });
    const t1 = await newTask("Set owner", "owner");
    const t2 = await newTask("Set reviewer", "reviewer");
    const t3 = await newTask("Check both", "check", [t1.id, t2.id]);
    expect(await state(t3)).toBe("CREATED");

    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "m4-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: { fake: { adapter: "generic-cli", command: process.execPath, args: ["-e", AGENT, "{objective}"] } },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();

    // t1 and t2 are independent branches: both are delivered from the same base.
    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(true);
    expect([await state(t1), await state(t2)]).toEqual(["REVIEW", "REVIEW"]);
    expect(await runner.runOnce()).toBe(false); // t3 is still waiting

    // Merge t1, then t2 conflicts with the new main.
    await approve(t1);
    await approve(t2);
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await store.processMergeQueue()).toMatchObject({ conflicts: 1 });
    expect([await state(t1), await state(t2), await state(t3)]).toEqual(["COMPLETED", "REWORK", "CREATED"]);

    // Rework: the runner merges main in, the agent resolves the conflict, delivery updates the PR.
    await store.sweep();
    expect(await runner.runOnce()).toBe(true);
    expect(await state(t2)).toBe("REVIEW");
    const t2Events = (await api<EventsPage>(`/tasks/${t2.id}/events?limit=1000`)).events;
    expect(
      t2Events.some((e) => e.type === "AgentEvent" && String(e.payload.text).includes("conflicts in README.md")),
    ).toBe(true);
    await approve(t2);
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await state(t2)).toBe("COMPLETED");
    expect(readText(join(origin.path, "README.md"))).toBe("# sample\nowner: team-a\nreviewer: team-b\n");

    // Both dependencies merged: t3 runs on top of them with their handoffs in context.
    expect(await state(t3)).toBe("READY");
    expect(await runner.runOnce()).toBe(true);
    expect(await state(t3)).toBe("REVIEW");
    await approve(t3);
    await store.processMergeQueue();
    expect(await state(t3)).toBe("COMPLETED");
    expect(readText(join(origin.path, "summary.txt"))).toBe("both changes present\n");

    const executions = await api<ExecutionDto[]>(`/tasks/${t2.id}/executions`);
    expect(executions.map((e) => e.status)).toEqual(["succeeded", "succeeded"]);
    expect(prs.get("task/M4-2")).toBe(2); // the rework updated the same pull request
  }, 120_000); // many git operations; slow when the whole suite runs in parallel
});
