import type { AgentDescriptor, CheckRun, ChecksState, ClaimResponse, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "../src/index.js";

/** Self-healing (spec §46): broken base branch, stuck work, lost sessions. */

let db: Db;
let app: FastifyInstance;
let store: Store;
let mainChecks: { state: ChecksState; runs: CheckRun[] };
const reverts: Array<{ number: number; title: string; body: string }> = [];
const provider: GitProvider = {
  async openPullRequest() {
    return { url: "https://github.com/o/r/pull/7", number: 7 };
  },
  async mergePullRequest() {
    return { status: "merged", sha: "abc1234def" };
  },
  async commitChecks() {
    return mainChecks;
  },
  async revertPullRequest(req) {
    reverts.push({ number: req.number, title: req.title, body: req.body });
    return { url: "https://github.com/o/r/pull/8", number: 8 };
  },
};

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db, { gitProvider: provider, ciGraceSeconds: 3600 });
  app = buildApp(store);
  reverts.length = 0;
  mainChecks = { state: "pending", runs: [] };
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: id,
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});

let project: ProjectDto;
let runnerId: string;
async function setup(extra: object = {}, agents = [agent("claude")]) {
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", ...extra })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents })).body.runnerId;
}
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const types = async (taskId: string) => (await call<EventsPage>(`GET`, `/tasks/${taskId}/events?limit=1000`)).body.events;

/** A task taken through delivery, review and the merge queue. */
async function mergedTask(): Promise<TaskDto> {
  const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refunds", objective: "Add refunds", agent: "claude" })).body;
  const c = await claim();
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s1", success: true, deniedActions: [], result: { summary: "ok" } },
  });
  await call("POST", `/executions/${c.execution.id}/validation`, { passed: true, steps: [], changedFiles: [] });
  await call("POST", `/executions/${c.execution.id}/delivery`, { branch: "task/PAY-1", commitSha: "abc1234", changedFiles: [] });
  await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });
  await store.processMergeQueue();
  expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("COMPLETED");
  return task;
}

const red = { state: "failure" as const, runs: [{ name: "test", state: "failure" as const, url: "https://ci/9", summary: "refund.test.js: 2 failing" }] };

describe("a merge that breaks the base branch", () => {
  it("waits for the base branch's CI, then records it healthy once", async () => {
    await setup();
    const task = await mergedTask();
    expect(await store.checkMergedCommits()).toEqual({ healthy: 0, broken: 0 });
    mainChecks = { state: "success", runs: [{ name: "test", state: "success", url: null, summary: null }] };
    expect(await store.checkMergedCommits()).toEqual({ healthy: 1, broken: 0 });
    expect(await store.checkMergedCommits()).toEqual({ healthy: 0, broken: 0 });
    expect((await types(task.id)).find((e) => e.type === "MainHealthy")?.payload).toMatchObject({ sha: "abc1234def" });
  });

  it("opens a revert pull request under the revert policy", async () => {
    await setup({ onBrokenMain: "revert" });
    const task = await mergedTask();
    mainChecks = red;
    expect(await store.checkMergedCommits()).toEqual({ healthy: 0, broken: 1 });
    expect(reverts).toEqual([{ number: 7, title: "Revert PAY-1: Refunds", body: expect.stringContaining("refund.test.js: 2 failing") }]);
    const events = await types(task.id);
    expect(events.find((e) => e.type === "MainBroken")?.payload).toMatchObject({ sha: "abc1234def", checks: ["test"], policy: "revert" });
    expect(events.find((e) => e.type === "RevertOpened")?.payload).toMatchObject({ number: 8 });
  });

  it("gives the agent a fix-forward task under the fix policy", async () => {
    await setup({ onBrokenMain: "fix" });
    const task = await mergedTask();
    mainChecks = red;
    await store.checkMergedCommits();
    const fix = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.find((t) => t.key === "PAY-2")!;
    expect(fix).toMatchObject({ title: "Fix main after PAY-1", agent: "claude", state: "READY" });
    expect(fix.objective).toContain("refund.test.js: 2 failing");
    expect(fix.objective).toContain("Add refunds");
    expect(reverts).toEqual([]);
    expect((await types(task.id)).map((e) => e.type)).toContain("FixTaskCreated");
  });

  it("only notifies by default, and the owner can change the policy", async () => {
    await setup();
    expect(project.onBrokenMain).toBe("notify");
    await mergedTask();
    mainChecks = red;
    await store.checkMergedCommits();
    expect(reverts).toEqual([]);
    expect((await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body).toHaveLength(1);
    expect((await call<ProjectDto>("PUT", `/projects/${project.id}/self-healing`, { onBrokenMain: "fix" })).body.onBrokenMain).toBe("fix");
  });
});

describe("stuck work", () => {
  const backdate = (taskId: string, interval: string) => db.query(`update tasks set updated_at = now() - interval '${interval}' where id = $1`, [taskId]);
  const stuck = async (taskId: string) => (await types(taskId)).filter((e) => e.type === "TaskStuck").map((e) => e.payload.reason);

  it("escalates READY work no runner can take, once, with the reason", async () => {
    await setup();
    const orphan = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "x", objective: "o", agent: "gemini" })).body;
    const auto = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "y", objective: "o", agent: "auto", requires: ["rust"] })).body;
    await backdate(orphan.id, "1 hour");
    await backdate(auto.id, "1 hour");
    expect(await store.escalateStuck({ readyMinutes: 30, humanHours: 8 })).toBe(2);
    expect(await store.escalateStuck({ readyMinutes: 30, humanHours: 8 })).toBe(0);
    expect(await stuck(orphan.id)).toEqual(["no online runner offers gemini"]);
    expect(await stuck(auto.id)).toEqual(["no online runner has an agent with rust"]);
  });

  it("explains a resting agent and work waiting for a person", async () => {
    await setup();
    await db.query("insert into agent_cooldowns (runner_id, agent, until, reason) values ($1, 'claude', now() + interval '2 hours', 'quota')", [runnerId]);
    const waiting = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "x", objective: "o", agent: "claude" })).body;
    await backdate(waiting.id, "1 hour");
    await store.escalateStuck({ readyMinutes: 30, humanHours: 8 });
    expect((await stuck(waiting.id))[0]).toMatch(/^every suitable agent is resting after a quota hit \(first back at /);

    // Later it was delivered and has waited 9 hours for a review (the first escalation came before that).
    await db.query("update events set created_at = now() - interval '10 hours' where type = 'TaskStuck'");
    await db.query("update tasks set state = 'REVIEW' where id = $1", [waiting.id]);
    await backdate(waiting.id, "9 hours");
    await store.escalateStuck({ readyMinutes: 30, humanHours: 8 });
    expect((await stuck(waiting.id))[1]).toBe("waiting for a review");
  });
});

describe("lost sessions", () => {
  it("starts a new session when the agent could not resume its own", async () => {
    await setup();
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "x", objective: "o", agent: "claude", maxAttempts: 3 })).body;
    const first = await claim();
    await call("POST", `/executions/${first.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    await call("POST", `/executions/${first.execution.id}/complete`, { exitCode: 1, terminal: { kind: "failed", sessionId: "s1", reason: "tests broke" } });
    await store.sweep();
    const second = await claim();
    expect(second.resume?.sessionId).toBe("s1");
    await call("POST", `/executions/${second.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    await call("POST", `/executions/${second.execution.id}/complete`, {
      exitCode: 1,
      terminal: { kind: "failed", sessionId: "s1", reason: "No conversation found with session ID: s1" },
    });
    await store.sweep();
    const third = await claim();
    expect(third.resume).toBeUndefined();
    expect((await types(task.id)).map((e) => e.type)).toContain("SessionDiscarded");
  });
});
