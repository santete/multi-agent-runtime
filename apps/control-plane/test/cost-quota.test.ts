import type { AgentCooldown, AgentDescriptor, AgentStats, ClaimResponse, CostReport, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Cost and quota (spec §39). */

let db: Db;
let app: FastifyInstance;
let store: Store;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db);
  app = buildApp(store);
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  id,
  adapter: id,
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
  ...extra,
});

let project: ProjectDto;
let runnerId: string;

async function setup(agents: AgentDescriptor[], projectExtra: object = {}) {
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", ...projectExtra })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents })).body.runnerId;
}

const task = async (agentId: string, extra: object = {}) =>
  (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: agentId, ...extra })).body;
const claim = async () => (await call<ClaimResponse | undefined>("POST", `/runners/${runnerId}/claim`)).body;

async function finish(c: ClaimResponse, terminal: object) {
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, { exitCode: 0, terminal });
}
const succeeded = (extra: object = {}) => ({ kind: "completed", sessionId: "s", success: true, deniedActions: [], result: { summary: "ok" }, ...extra });
const failed = (reason: string) => ({ kind: "failed", sessionId: "s", reason });

describe("cost", () => {
  it("records reported and estimated cost and reports spend per day and agent", async () => {
    await setup([agent("claude"), agent("codex", { pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } })]);
    await task("claude");
    await task("codex");
    await finish((await claim())!, succeeded({ costUsd: 0.3, usage: { inputTokens: 1000, outputTokens: 2000 } }));
    await finish((await claim())!, succeeded({ usage: { inputTokens: 2_000_000, outputTokens: 100_000 } }));

    const report = (await call<CostReport>("GET", `/projects/${project.id}/costs`)).body;
    expect(report.todayUsd).toBeCloseTo(3.8);
    expect(report.rows.map((r) => [r.agent, r.executions, r.costUsd, r.estimated])).toEqual([
      ["claude", 1, 0.3, false],
      ["codex", 1, 3.5, true],
    ]);
    const stats = (await call<AgentStats[]>("GET", "/agents/stats")).body;
    expect(stats.find((s) => s.agent === "codex")).toMatchObject({ inputTokens: 2_000_000, outputTokens: 100_000, costUsd: 3.5 });
  });
});

describe("quota", () => {
  it("rests an agent that hit its quota on that runner, until a person clears it", async () => {
    await setup([agent("claude")]);
    await task("claude");
    await finish((await claim())!, failed("Claude AI usage limit reached; try again in 2 hours"));

    const [cooldown] = (await call<AgentCooldown[]>("GET", "/agents/cooldowns")).body;
    expect(cooldown).toMatchObject({ runnerId, runnerName: "box", agent: "claude" });
    expect(Date.parse(cooldown!.until) - Date.now()).toBeGreaterThan(110 * 60_000);

    await store.sweep();
    await task("claude");
    expect(await claim()).toBeFalsy();

    expect((await call("DELETE", `/runners/${runnerId}/cooldowns/claude`)).status).toBe(204);
    expect((await claim())?.task.agent).toBe("claude");
  });

  it("moves auto-routed work to an agent that is not resting", async () => {
    await setup([agent("claude", { skills: ["ts"] }), agent("codex", { skills: ["ts"] })]);
    await call("POST", "/runners/register", { name: "box", agents: [agent("claude", { skills: ["ts"] }), agent("codex", { skills: ["ts"] })] });
    await db.query("insert into agent_cooldowns (runner_id, agent, until, reason) values ($1, 'claude', now() + interval '1 hour', 'quota')", [runnerId]);
    await task("auto", { requires: ["ts"] });
    expect((await claim())!.task.agent).toBe("codex");
  });

  it("respects an agent's concurrency limit on the runner", async () => {
    await setup([agent("claude", { maxConcurrent: 1 })]);
    await task("claude");
    await task("claude");
    const first = (await claim())!;
    expect(await claim()).toBeFalsy();
    await finish(first, succeeded());
    // validating still counts as running work: the lease is held until delivery.
    await call("POST", `/executions/${first.execution.id}/validation`, { passed: true, steps: [], changedFiles: [] });
    await call("POST", `/executions/${first.execution.id}/delivery`, { branch: "task/PAY-1", commitSha: null, changedFiles: [] });
    expect((await claim())?.task.key).toBe("PAY-2");
  });
});

describe("budgets", () => {
  it("holds a project's work once its daily budget is spent, and says so once", async () => {
    await setup([agent("claude")], { budget: { dailyUsd: 0.5 } });
    await task("claude");
    await finish((await claim())!, succeeded({ costUsd: 0.6 }));
    await task("claude");
    expect(await claim()).toBeFalsy();
    await store.sweep();
    await store.sweep();
    const events = (await call<EventsPage>("GET", `/projects/${project.id}/events?limit=1000`)).body.events;
    expect(events.filter((e) => e.type === "BudgetExceeded").map((e) => e.payload)).toEqual([{ spentUsd: 0.6, dailyUsd: 0.5 }]);

    await call("PUT", `/projects/${project.id}/budget`, { dailyUsd: 5 });
    expect((await claim())?.task.key).toBe("PAY-2");
  });

  it("stops a task that used up its own budget", async () => {
    await setup([agent("claude")], { budget: { perTaskUsd: 0.5 } });
    const t = await task("claude", { maxAttempts: 5 });
    // Claude reports an unsuccessful run with its cost.
    const unsuccessful = succeeded({ success: false, costUsd: 0.3, result: "tests broke" });
    await finish((await claim())!, unsuccessful);
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${t.id}`)).body.state).toBe("READY");
    await finish((await claim())!, unsuccessful);
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${t.id}`)).body.state).toBe("BLOCKED");
    const types = (await call<EventsPage>("GET", `/tasks/${t.id}/events?limit=1000`)).body.events.map((e) => e.type);
    expect(types).toContain("TaskBudgetExceeded");
  });

  it("validates budgets", async () => {
    await setup([agent("claude")]);
    expect((await call("PUT", `/projects/${project.id}/budget`, { dailyUsd: -1 })).status).toBe(400);
    expect((await call<ProjectDto>("PUT", `/projects/${project.id}/budget`, null)).body.budget).toBeNull();
  });
});
