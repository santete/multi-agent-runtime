import type { AgentDescriptor, ClaimResponse, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, type PullRequestStatus, Store } from "../src/index.js";

/** Merge queue gates (spec §27, §34): re-validation on a moved base, CI checks. */

let db: Db;
let app: FastifyInstance;
let store: Store;

let status: PullRequestStatus;
const merged: number[] = [];
const provider: GitProvider = {
  async openPullRequest() {
    return { url: "https://github.com/o/r/pull/1", number: 1 };
  },
  async mergePullRequest(req) {
    merged.push(req.number);
    return { status: "merged", sha: "abc" };
  },
  async pullRequestStatus() {
    return status;
  },
};
const green = (): PullRequestStatus => ({
  headSha: "h1",
  behindBase: false,
  checks: { state: "success", runs: [{ name: "test", state: "success", url: null, summary: null }] },
});

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db, { gitProvider: provider, ciGraceSeconds: 3600 });
  app = buildApp(store);
  status = green();
  merged.length = 0;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const descriptor: AgentDescriptor = {
  id: "dev",
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
};

async function setup(policy: object = {}) {
  const project = (
    await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", ...policy })
  ).body;
  const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "a", objective: "o", agent: "dev", maxAttempts: 2 }))
    .body;
  const runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r1", agents: [descriptor] })).body.runnerId;
  return { project, task, runnerId };
}

const claim = async (runnerId: string) => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body.state;
const types = async (id: string) => (await call<EventsPage>("GET", `/tasks/${id}/events?limit=1000`)).body.events.map((e) => e.type);

/** Runs the claimed execution through validation and delivery. */
async function deliver(c: ClaimResponse, revalidation = false) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: revalidation ? "" : "s1", success: true, deniedActions: [], result: { summary: "done" } },
    ...(revalidation && { revalidation }),
  });
  await call("POST", `/executions/${id}/validation`, { passed: true, steps: [], changedFiles: [] });
  await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: [] });
}

describe("re-validation on a moved base", () => {
  it("sends the task back to be re-validated, then merges it without a new review", async () => {
    const { task, runnerId } = await setup({ reviewAgents: ["dev", "other"] });
    await deliver(await claim(runnerId));
    // The agent review of the delivery is not what this test is about.
    await db.query("update tasks set state = 'CANCELLED' where kind = 'review'");
    await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });

    status = { ...green(), behindBase: true };
    expect(await store.processMergeQueue()).toMatchObject({ revalidating: 1, merged: 0 });
    expect(await state(task.id)).toBe("REWORK");
    await store.sweep();

    const c = await claim(runnerId);
    expect(c.rework).toEqual({ kind: "base_changed", attempt: 1, reason: "main moved after the change was validated", baseBranch: "main" });
    await deliver(c, true);
    // Back in the queue, still approved; no new agent review was requested.
    expect(await state(task.id)).toBe("APPROVED");
    expect((await call<TaskDto[]>("GET", `/projects/${task.projectId}/tasks`)).body.filter((t) => t.kind === "review")).toHaveLength(1);

    status = green();
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await state(task.id)).toBe("COMPLETED");
    expect(await types(task.id)).toEqual(expect.arrayContaining(["BaseChanged", "TaskMerged"]));
  });

  it("does not use up attempts on re-validations", async () => {
    const { task, runnerId } = await setup();
    await deliver(await claim(runnerId));
    await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });
    // maxAttempts is 2: three moves of the base still re-validate.
    for (let i = 0; i < 3; i++) {
      status = { ...green(), behindBase: true };
      await store.processMergeQueue();
      await store.sweep();
      expect(await state(task.id)).toBe("READY");
      await deliver(await claim(runnerId), true);
    }
    status = green();
    await store.processMergeQueue();
    expect(await state(task.id)).toBe("COMPLETED");
  });

  it("can be turned off per project", async () => {
    const { project, task, runnerId } = await setup();
    await call("PUT", `/projects/${project.id}/merge-policy`, { revalidateOnBaseChange: false, waitForChecks: false });
    await deliver(await claim(runnerId));
    await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });
    status = { ...green(), behindBase: true };
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
  });
});

describe("CI checks", () => {
  async function approved(policy: object = { waitForChecks: true }) {
    const s = await setup(policy);
    await deliver(await claim(s.runnerId));
    await call("POST", `/tasks/${s.task.id}/review`, { decision: "approve" });
    return s;
  }

  it("holds the merge while checks run, then merges when they pass", async () => {
    const { task } = await approved();
    status = { ...green(), checks: { state: "pending", runs: [{ name: "test", state: "pending", url: null, summary: null }] } };
    expect(await store.processMergeQueue()).toMatchObject({ waiting: 1, merged: 0 });
    expect(await store.processMergeQueue()).toMatchObject({ waiting: 1 });
    expect(await state(task.id)).toBe("MERGING");

    status = green();
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    const seen = await types(task.id);
    expect(seen.filter((t) => t === "CiPending")).toHaveLength(1);
    expect(seen).toContain("CiPassed");
  });

  it("sends failed checks back to the agent with what failed", async () => {
    const { task, runnerId } = await approved();
    const failing = { name: "test (node 22)", state: "failure" as const, url: "https://ci/1", summary: "1 failing: refund rounds" };
    status = { ...green(), checks: { state: "failure", runs: [failing, { name: "lint", state: "success", url: null, summary: null }] } };
    expect(await store.processMergeQueue()).toMatchObject({ ciFailed: 1 });
    expect(await state(task.id)).toBe("REWORK");
    await store.sweep();
    expect((await claim(runnerId)).rework).toEqual({
      kind: "ci",
      attempt: 1,
      reason: "CI checks failed: test (node 22)",
      checks: [failing],
    });
  });

  it("merges without CI when no check shows up within the grace period", async () => {
    store = new Store(db, { gitProvider: provider, ciGraceSeconds: 0 });
    app = buildApp(store);
    const { task } = await approved();
    status = { ...green(), checks: { state: "none", runs: [] } };
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
    expect(await types(task.id)).toContain("CiSkipped");
  });

  it("does not let a task be cancelled while it is being merged", async () => {
    const { task } = await approved();
    status = { ...green(), checks: { state: "pending", runs: [] } };
    await store.processMergeQueue();
    expect(await state(task.id)).toBe("MERGING");
    expect((await call("POST", `/tasks/${task.id}/cancel`)).status).toBe(409);
  });

  it("ignores checks unless the project waits for them", async () => {
    await approved({});
    status = { ...green(), checks: { state: "failure", runs: [] } };
    expect(await store.processMergeQueue()).toMatchObject({ merged: 1 });
  });
});
