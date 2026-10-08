import type { AgentDescriptor, AgentStats, ClaimResponse, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Capability routing and reassignment (spec §25, §38, §46). */

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

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string, skills: string[], cost: "low" | "medium" | "high" = "medium"): AgentDescriptor => ({
  id,
  adapter: id,
  skills,
  cost,
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});

const AGENTS = [agent("claude", ["typescript", "backend"], "high"), agent("codex", ["typescript", "backend"]), agent("agy", ["frontend"], "low")];

async function setup(task: Record<string, unknown>, agents = AGENTS, routingPolicy?: string) {
  const project = (
    await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", routingPolicy })
  ).body;
  const created = await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "T", objective: "Do it", ...task });
  const runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents })).body.runnerId;
  return { project, task: created.body, runnerId };
}

const claim = async (runnerId: string) => (await call<ClaimResponse | null>("POST", `/runners/${runnerId}/claim`)).body;
const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;
const events = async (id: string) => (await call<EventsPage>("GET", `/tasks/${id}/events`)).body.events;

async function fail(c: ClaimResponse, reason: string, sessionId = "s1") {
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, { exitCode: 1, terminal: { kind: "failed", sessionId, reason } });
}

describe("auto routing", () => {
  it("picks an agent with the required skills and records why", async () => {
    const { task, runnerId } = await setup({ agent: "auto", requires: ["frontend"] });
    expect(task).toMatchObject({ agent: "auto", routing: "auto", requires: ["frontend"] });

    const c = (await claim(runnerId))!;
    expect(c.task).toMatchObject({ id: task.id, agent: "agy" });
    expect(c.execution.agent).toBe("agy");
    const selected = (await events(task.id)).find((e) => e.type === "AgentSelected");
    expect(selected?.payload).toMatchObject({ agent: "agy", requires: ["frontend"], reason: expect.stringContaining("has frontend") });
  });

  it("never routes to a plain command agent, even the cheapest", async () => {
    const shell = { ...agent("shell", [], "low"), adapter: "generic-cli" };
    const { task, runnerId } = await setup({ agent: "auto" }, [shell, agent("claude", ["typescript"], "high")]);
    expect((await claim(runnerId))!.task).toMatchObject({ id: task.id, agent: "claude" });
  });

  it("follows the project's routing policy", async () => {
    const { runnerId } = await setup({ agent: "auto", requires: ["backend"] }, AGENTS, "cost");
    expect((await claim(runnerId))!.task.agent).toBe("codex");
  });

  it("leaves a task no offered agent can do for another runner", async () => {
    const { task, runnerId } = await setup({ agent: "auto", requires: ["rust"] });
    expect(await claim(runnerId)).toBeFalsy();
    expect((await state(task.id)).state).toBe("READY");
  });
});

describe("reassignment", () => {
  it("excludes an unavailable agent and routes the retry elsewhere", async () => {
    const { task, runnerId } = await setup({ agent: "auto", requires: ["backend"] }, AGENTS, "cost");
    const first = (await claim(runnerId))!;
    expect(first.task.agent).toBe("codex");
    await fail(first, "You've hit your usage limit");
    await store.sweep();

    expect(await state(task.id)).toMatchObject({ agent: "auto", excludedAgents: ["codex"], state: "READY" });
    const reassigned = (await events(task.id)).find((e) => e.type === "TaskReassigned");
    expect(reassigned?.payload).toMatchObject({ from: "codex", to: "auto", reason: expect.stringContaining("usage limit") });

    const second = (await claim(runnerId))!;
    expect(second.task.agent).toBe("claude");
    // The other agent's session cannot be resumed.
    expect(second.resume).toBeUndefined();
  });

  it("switches a fixed task to its fallback after two failures in a row", async () => {
    const { task, runnerId } = await setup({ agent: "claude", fallbackAgents: ["codex"], maxAttempts: 4 });
    await fail((await claim(runnerId))!, "tests broke");
    await store.sweep();
    const again = (await claim(runnerId))!;
    expect(again.task.agent).toBe("claude");
    expect(again.resume?.sessionId).toBe("s1");

    await fail(again, "tests broke again");
    await store.sweep();
    expect(await state(task.id)).toMatchObject({ agent: "codex", excludedAgents: ["claude"] });
    expect((await claim(runnerId))!.task.agent).toBe("codex");
  });

  it("hands a fixed task without fallbacks to automatic routing, without the agent that failed", async () => {
    const { task, runnerId } = await setup({ agent: "claude" });
    await fail((await claim(runnerId))!, "quota exceeded");
    await store.sweep();
    expect(await state(task.id)).toMatchObject({ agent: "auto", routing: "auto", excludedAgents: ["claude"], state: "READY" });
  });
});

describe("agent stats", () => {
  it("aggregates executions per agent", async () => {
    const { project, runnerId } = await setup({ agent: "claude", fallbackAgents: ["codex"], maxAttempts: 4 });
    await fail((await claim(runnerId))!, "boom");
    await store.sweep();
    await claim(runnerId);

    const stats = (await call<AgentStats[]>("GET", `/agents/stats?projectId=${project.id}`)).body;
    expect(stats).toEqual([expect.objectContaining({ agent: "claude", executions: 2, failed: 1, succeeded: 0, active: 1 })]);
  });
});
