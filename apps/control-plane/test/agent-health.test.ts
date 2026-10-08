import type { AgentDescriptor, ClaimResponse, EventDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** What a runner's preflight says about its agents decides who gets which task. */

let db: Db;
let app: FastifyInstance;
let store: Store;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, decisions, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db);
  app = buildApp(store);
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: "claude-code",
  skills: ["backend"],
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
});

let runnerId: string;
let project: ProjectDto;
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const task = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;
const events = async (id: string) => (await call<{ events: EventDto[] }>("GET", `/tasks/${id}/events`)).body.events;
const health = (a: string, status: string, reason = "") => call("POST", `/runners/${runnerId}/agent-health`, { agent: a, status, reason });

async function setup(ids: string[], body: object = {}) {
  project = (await call<ProjectDto>("POST", "/projects", { key: "TBP", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: ids.map(agent) })).body.runnerId;
  return (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "A", objective: "o", agent: "codex", routing: "fixed", ...body })).body;
}

const workspaceFailure = (c: ClaimResponse) =>
  call("POST", `/executions/${c.execution.id}/complete`, { exitCode: null, terminal: { kind: "failed", reason: "workspace preparation failed: disk full" } });

describe("preflight results", () => {
  it("are recorded, and only a change is an event", async () => {
    await setup(["codex", "claude"]);
    expect((await health("codex", "unavailable", "You've reached your credit usage limit")).status).toBe(204);
    await health("codex", "unavailable", "still");
    const list = (await call<Array<{ agent: string; status: string; reason: string }>>("GET", "/agents/health")).body;
    expect(list).toEqual([expect.objectContaining({ agent: "codex", status: "unavailable", reason: "still" })]);
    const recent = (await call<EventDto[] | { events: EventDto[] }>("GET", "/events/recent?limit=50")).body;
    const changed = (Array.isArray(recent) ? recent : recent.events).filter((e) => e.type === "AgentHealthChanged");
    expect(changed).toHaveLength(1);
  });

  it("send a task of an agent that cannot run to its fallback agent", async () => {
    const t = await setup(["codex", "claude"], { fallbackAgents: ["claude"] });
    await health("codex", "unavailable", "no credit");
    await store.sweep();
    expect(await task(t.id)).toMatchObject({ agent: "claude" });
    expect((await events(t.id)).find((e) => e.type === "TaskReassigned")?.payload.reason).toContain("failed its preflight: no credit");
    expect((await claim()).task.id).toBe(t.id);
  });

  it("send it to automatic routing without that agent when no fallback is named", async () => {
    const t = await setup(["codex", "claude"]);
    await health("codex", "unavailable", "no credit");
    await store.sweep();
    expect(await task(t.id)).toMatchObject({ agent: "auto", routing: "auto", excludedAgents: ["codex"] });
    const c = await claim();
    expect(c.task).toMatchObject({ id: t.id, agent: "claude" });
  });

  it("keep an agent that cannot run commands away from work", async () => {
    const t = await setup(["codex", "claude"]);
    await health("codex", "no_shell", "commands are denied in headless mode");
    // Claimed from a runner that only has the weak agent: nothing to take.
    expect(await claim()).toBeFalsy();
    await store.sweep();
    expect((await task(t.id)).agent).toBe("auto");
  });

  it("leave the task alone when no other agent is online", async () => {
    const t = await setup(["codex"]);
    await health("codex", "unavailable", "no credit");
    await store.sweep();
    expect((await task(t.id)).agent).toBe("codex");
    expect(await (store as unknown as { stuckReason(t: TaskDto): Promise<string> }).stuckReason(await task(t.id))).toContain("failed its preflight");
  });

  it("do not move anything for an agent that is ready", async () => {
    const t = await setup(["codex", "claude"]);
    await health("codex", "ready");
    await store.sweep();
    expect((await task(t.id)).agent).toBe("codex");
  });
});

describe("a task that fails twice without any fallback agent named", () => {
  it("goes to automatic routing instead of staying with the failing agent", async () => {
    const t = await setup(["codex", "claude"], { maxAttempts: 5 });
    await workspaceFailure(await claim());
    await store.sweep();
    await workspaceFailure(await claim());
    await store.sweep();
    expect(await task(t.id)).toMatchObject({ agent: "auto", routing: "auto", excludedAgents: ["codex"] });
    expect((await events(t.id)).find((e) => e.type === "TaskReassigned")?.payload).toMatchObject({ from: "codex", to: "auto", reason: "failed twice in a row" });
  });
});
