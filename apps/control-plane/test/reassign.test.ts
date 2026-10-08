import type { AgentDescriptor, ClaimResponse, EventDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** A person hands a stuck task to another agent. */

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

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
});

let runnerId: string;
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const workspaceFailure = (c: ClaimResponse) =>
  call("POST", `/executions/${c.execution.id}/complete`, { exitCode: null, terminal: { kind: "failed", reason: "workspace preparation failed: disk full" } });

async function setup(maxAttempts = 2) {
  const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: [agent("dev"), agent("other")] })).body.runnerId;
  const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "A", objective: "o", agent: "dev", maxAttempts })).body;
  return { project, task };
}

describe("handing a task to another agent", () => {
  it("moves a blocked task to the chosen agent and keeps the old one out", async () => {
    const { task } = await setup();
    await workspaceFailure(await claim());
    await store.sweep();
    await workspaceFailure(await claim());
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("BLOCKED");

    const moved = (await call<TaskDto>("POST", `/tasks/${task.id}/reassign`, { agent: "other" })).body;
    expect(moved).toMatchObject({ agent: "other", routing: "fixed", state: "READY" });
    expect(moved.excludedAgents).toContain("dev");

    const events = (await call<{ events: EventDto[] }>("GET", `/tasks/${task.id}/events`)).body.events;
    expect(events.find((e) => e.type === "TaskReassigned" && e.payload.reason === "handed to another agent by a person")).toMatchObject({
      payload: { from: "auto", to: "other" },
    });
    // The new agent picks it up.
    expect((await claim()).task.id).toBe(task.id);
  });

  it("gives the new agent a fresh set of attempts, so one failure does not block the task again", async () => {
    const { task } = await setup();
    await workspaceFailure(await claim());
    await store.sweep();
    await workspaceFailure(await claim());
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("BLOCKED");

    await call("POST", `/tasks/${task.id}/reassign`, { agent: "other" });
    await workspaceFailure(await claim());
    await store.sweep();
    // Without the fresh start this would be BLOCKED: three executions against a limit of two.
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body).toMatchObject({ state: "READY", agent: "other" });
    await workspaceFailure(await claim());
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("BLOCKED");
  });

  it("gives a retried task a fresh set of attempts too", async () => {
    const { task } = await setup();
    await workspaceFailure(await claim());
    await store.sweep();
    await workspaceFailure(await claim());
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("BLOCKED");
    await call("POST", `/tasks/${task.id}/retry`);
    await workspaceFailure(await claim());
    await store.sweep();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("READY");
  });

  it("refuses an agent whose preflight ruled it out, since the scheduler would take the task back", async () => {
    const { task } = await setup();
    await call("POST", `/runners/${runnerId}/agent-health`, { agent: "other", status: "unavailable", reason: "no credit" });
    const refused = await call<{ error: string }>("POST", `/tasks/${task.id}/reassign`, { agent: "other" });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("failed its preflight: no credit");
    await call("POST", `/runners/${runnerId}/agent-health`, { agent: "other", status: "ready" });
    expect((await call("POST", `/tasks/${task.id}/reassign`, { agent: "other" })).status).toBe(200);
  });

  it("can hand a ready task over, and refuses unknown agents, the same agent and finished tasks", async () => {
    const { task } = await setup();
    expect((await call("POST", `/tasks/${task.id}/reassign`, { agent: "nobody" })).status).toBe(409);
    expect((await call("POST", `/tasks/${task.id}/reassign`, { agent: "dev" })).status).toBe(409);
    expect((await call<TaskDto>("POST", `/tasks/${task.id}/reassign`, { agent: "auto" })).body).toMatchObject({ agent: "auto", routing: "auto" });
    await call("POST", `/tasks/${task.id}/cancel`);
    expect((await call("POST", `/tasks/${task.id}/reassign`, { agent: "other" })).status).toBe(409);
  });
});
