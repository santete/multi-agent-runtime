import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "@mar/control-plane";
import type { ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

// Writes the file named by its objective; refuses to run twice on the same branch,
// so a re-validation that wrongly ran the agent would fail.
const WORKER = `
const fs = require("fs");
if (fs.existsSync(process.argv[1])) { console.error("agent ran again"); process.exit(1); }
fs.writeFileSync(process.argv[1], "ok\\n");`;

describe("re-validation on a moved base with real git", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;
  let prs = 0;
  const heads = new Map<number, string>();
  // Pull requests are the pushed task branches of the origin repository.
  const provider: GitProvider = {
    async openPullRequest(req) {
      const existing = [...heads].find(([, head]) => head === req.head);
      if (existing) return { url: `local://pr/${existing[0]}`, number: existing[0] };
      heads.set(++prs, req.head);
      return { url: `local://pr/${prs}`, number: prs };
    },
    async mergePullRequest(req) {
      await git(origin.path, "-c", "user.name=m", "-c", "user.email=m@x", "merge", "--no-ff", "--no-edit", req.head);
      return { status: "merged", sha: null };
    },
    async pullRequestStatus(req) {
      const head = heads.get(req.number)!;
      const behindBase = await git(origin.path, "merge-base", "--is-ancestor", "main", head).then(
        () => false,
        () => true,
      );
      return { headSha: await git(origin.path, "rev-parse", head), behindBase, checks: { state: "none", runs: [] } };
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

  it("merges the new base in, re-validates without the agent and merges", async () => {
    const project = await api<ProjectDto>("/projects", { key: "RV", name: "revalidate", repoUrl: origin.path });
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "rv-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: { worker: { adapter: "generic-cli", command: process.execPath, args: ["-e", WORKER, "{objective}"] } },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();
    const a = await api<TaskDto>(`/projects/${project.id}/tasks`, { title: "a", objective: "a.txt", agent: "worker" });
    const b = await api<TaskDto>(`/projects/${project.id}/tasks`, { title: "b", objective: "b.txt", agent: "worker" });
    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(true);
    expect([await state(a.id), await state(b.id)]).toEqual(["REVIEW", "REVIEW"]);
    // From now on the validation needs a.txt: b only passes on top of the merged a.
    await fetch(`${baseUrl}/projects/${project.id}/validation`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ name: "files", command: `node -e "process.exit(require('fs').existsSync('a.txt') ? 0 : 1)"` }]),
    });

    await api(`/tasks/${a.id}/review`, { decision: "approve" });
    await api(`/tasks/${b.id}/review`, { decision: "approve" });
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await state(a.id)).toBe("COMPLETED");

    // main moved: b is re-validated on it instead of being merged blind.
    expect(await store.processMergeQueue()).toMatchObject({ revalidating: 1 });
    await store.sweep();
    expect(await runner.runOnce()).toBe(true);
    expect(await state(b.id)).toBe("APPROVED");
    const executions = await api<ExecutionDto[]>(`/tasks/${b.id}/executions`);
    expect(executions.map((e) => e.status)).toEqual(["succeeded", "succeeded"]);

    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await state(b.id)).toBe("COMPLETED");
    await git(origin.path, "checkout", "-q", "main");
    expect(existsSync(join(origin.path, "a.txt")) && existsSync(join(origin.path, "b.txt"))).toBe(true);
  });
});
