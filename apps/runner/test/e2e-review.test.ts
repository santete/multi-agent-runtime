import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "@mar/control-plane";
import type { ArtifactDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

// The author writes a TODO on its first attempt and fixes it when the review asks for it.
const AUTHOR = `
const fs = require("fs");
const rework = fs.existsSync(".orchestrator/context/REWORK.md") ? fs.readFileSync(".orchestrator/context/REWORK.md", "utf8") : "";
fs.writeFileSync("refund.js", rework.includes("remove the TODO") ? "export const refund = (a) => a;\\n" : "// TODO: validate\\nexport const refund = (a) => a;\\n");
console.log("wrote refund.js");`;

// The reviewer reads the platform's diff and brief; it must not see its own
// files in the diff and asks for changes while a TODO is left.
const REVIEWER = `
const fs = require("fs");
const diff = fs.readFileSync(".orchestrator/context/DIFF.patch", "utf8");
const brief = fs.readFileSync(".orchestrator/context/REVIEW.md", "utf8");
if (!brief.includes("Review M5R-1") || !diff.includes("refund.js")) process.exit(3);
const todo = diff.includes("TODO");
console.log(JSON.stringify(todo
  ? { verdict: "request_changes", summary: "A TODO is left in the code.", findings: [{ severity: "major", file: "refund.js", line: 1, message: "remove the TODO and validate the amount" }] }
  : { verdict: "approve", summary: "Clean.", findings: [] }));`;

describe("cross-agent review with real git", () => {
  let db: Db;
  let store: Store;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;
  const prComments: string[] = [];
  const provider: GitProvider = {
    async openPullRequest() {
      return { url: "local://pr/1", number: 1 };
    },
    async mergePullRequest(req) {
      await git(origin.path, "-c", "user.name=m", "-c", "user.email=m@x", "merge", "--no-ff", "--no-edit", req.head);
      return { status: "merged", sha: null };
    },
    async commentOnPullRequest(req) {
      prComments.push(req.body);
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

  it("reviews, sends back, re-reviews and merges", async () => {
    const project = await api<ProjectDto>("/projects", {
      key: "M5R",
      name: "review",
      repoUrl: origin.path,
      reviewAgents: ["author", "reviewer"],
      autoApproveOnAgentReview: true,
    });
    const task = await api<TaskDto>(`/projects/${project.id}/tasks`, { title: "Refund", objective: "write refund.js", agent: "author" });
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "review-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: {
          author: { adapter: "generic-cli", command: process.execPath, args: ["-e", AUTHOR] },
          reviewer: { adapter: "generic-cli", command: process.execPath, args: ["-e", REVIEWER] },
        },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();

    // 1. The author delivers; a review task for the other agent appears.
    expect(await runner.runOnce()).toBe(true);
    expect(await state(task.id)).toBe("REVIEW");
    const reviews = () => api<TaskDto[]>(`/projects/${project.id}/tasks`).then((ts) => ts.filter((t) => t.kind === "review"));
    const [firstReview] = await reviews();
    expect(firstReview).toMatchObject({ agent: "reviewer", reviewOf: task.id });

    // 2. The reviewer requests changes: the task goes back to its author with the findings.
    expect(await runner.runOnce()).toBe(true);
    expect(await state(firstReview!.id)).toBe("COMPLETED");
    expect(await state(task.id)).toBe("REWORK");
    expect(prComments[0]).toContain("[major] refund.js:1 — remove the TODO");

    // 3. The author reworks on the same branch; a new review approves; auto-merge.
    await store.sweep();
    expect(await runner.runOnce()).toBe(true);
    expect(await state(task.id)).toBe("REVIEW");
    expect(await runner.runOnce()).toBe(true);
    expect(await state(task.id)).toBe("APPROVED");
    await store.processMergeQueue();
    expect(await state(task.id)).toBe("COMPLETED");

    const merged = readFileSync(join(origin.path, "refund.js"), "utf8").replace(/\r\n/g, "\n");
    expect(merged).toBe("export const refund = (a) => a;\n");
    // Review worktrees never deliver anything: only the author's branch exists.
    expect((await git(origin.path, "branch", "--list", "task/*")).split("\n").map((b) => b.trim().replace("* ", ""))).toEqual([
      "task/M5R-1",
    ]);

    const verdicts = (await api<ArtifactDto[]>(`/tasks/${task.id}/artifacts`))
      .filter((a) => a.type === "review_result")
      .map((a) => a.content.verdict);
    expect(verdicts).toEqual(["request_changes", "approve"]);
    expect(await reviews()).toHaveLength(2);
  });
});
