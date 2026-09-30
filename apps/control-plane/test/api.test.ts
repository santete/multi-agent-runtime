import type { ClaimResponse, EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

let db: Db;
let app: FastifyInstance;

// PGlite takes seconds to boot, so share one instance per file and reset data per test.
beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("truncate events, executions, tasks, runners, projects restart identity cascade");
  app = buildApp(new Store(db));
});

afterEach(async () => {
  await app.close();
});

async function call<T>(method: "GET" | "POST", url: string, payload?: object): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, ...(payload && { payload }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function setup(agent = "shell") {
  const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "Payment", repoUrl: "/tmp/repo" }))
    .body;
  const task = (
    await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refund", objective: "echo hi", agent })
  ).body;
  const { runnerId } = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r1", agents: ["shell"] }))
    .body;
  return { project, task, runnerId };
}

async function claimAndStart(runnerId: string) {
  const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${claim.execution.id}/start`, { workspace: "/ws/PAY-1", branch: "task/PAY-1" });
  return claim;
}

describe("projects", () => {
  it("creates and lists projects", async () => {
    const created = await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "Payment", repoUrl: "git@x:y.git" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: "PAY", defaultBranch: "main" });
    expect((await call<ProjectDto[]>("GET", "/projects")).body).toHaveLength(1);
  });

  it("rejects invalid input and duplicate keys", async () => {
    expect((await call("POST", "/projects", { key: "bad key", name: "x", repoUrl: "y" })).status).toBe(400);
    await call("POST", "/projects", { key: "PAY", name: "x", repoUrl: "y" });
    expect((await call("POST", "/projects", { key: "PAY", name: "x", repoUrl: "y" })).status).toBe(409);
  });

  it("returns 404 for unknown ids and 400 for malformed ids", async () => {
    expect((await call("GET", "/projects/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call("GET", "/projects/nope")).status).toBe(400);
  });
});

describe("tasks", () => {
  it("creates tasks with sequential keys, ready to run", async () => {
    const { project, task } = await setup();
    expect(task).toMatchObject({ key: "PAY-1", state: "READY", agent: "shell" });
    const second = await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
      title: "t2",
      objective: "o",
      agent: "shell",
    });
    expect(second.body.key).toBe("PAY-2");
  });

  it("records TaskCreated and the READY transition as events", async () => {
    const { task } = await setup();
    const { events } = (await call<EventsPage>("GET", `/tasks/${task.id}/events`)).body;
    expect(events.map((e) => e.type)).toEqual(["TaskCreated", "TaskStateChanged"]);
    expect(events[1]!.payload).toMatchObject({ from: "CREATED", to: "READY", trigger: "dependencies_satisfied" });
  });

  it("cancels a task once", async () => {
    const { task } = await setup();
    expect((await call<TaskDto>("POST", `/tasks/${task.id}/cancel`)).body.state).toBe("CANCELLED");
    expect((await call("POST", `/tasks/${task.id}/cancel`)).status).toBe(409);
  });
});

describe("runner protocol", () => {
  it("hands a READY task to exactly one runner", async () => {
    const { task, runnerId } = await setup();
    const first = await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`);
    expect(first.status).toBe(200);
    expect(first.body.task).toMatchObject({ id: task.id, state: "ASSIGNED" });
    expect(first.body.execution).toMatchObject({ attempt: 1, status: "assigned" });
    expect(first.body.project.key).toBe("PAY");
    expect((await call("POST", `/runners/${runnerId}/claim`)).status).toBe(204);
  });

  it("only offers tasks for agents the runner has", async () => {
    const { runnerId } = await setup("claude-code");
    expect((await call("POST", `/runners/${runnerId}/claim`)).status).toBe(204);
  });

  it("runs a task to VALIDATING and keeps the agent event log", async () => {
    const { task, runnerId } = await setup();
    const { execution } = await claimAndStart(runnerId);
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("RUNNING");

    const events = [
      { kind: "session_started", sessionId: "sess-1" },
      { kind: "message", text: "hi" },
    ];
    expect((await call("POST", `/executions/${execution.id}/events`, { events })).status).toBe(204);

    const done = await call<ExecutionDto>("POST", `/executions/${execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "sess-1", success: true, deniedActions: [], result: "hi" },
    });
    expect(done.body).toMatchObject({ status: "succeeded", exitCode: 0, sessionId: "sess-1" });
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("VALIDATING");

    const log = (await call<EventsPage>("GET", `/executions/${execution.id}/events`)).body.events;
    expect(log.map((e) => e.type)).toEqual(["ExecutionAssigned", "ExecutionStarted", "AgentEvent", "AgentEvent", "ExecutionFinished"]);
    expect(log[3]!.payload).toEqual({ kind: "message", text: "hi" });
  });

  it("parks tasks with denied actions for a human", async () => {
    const { task, runnerId } = await setup();
    const { execution } = await claimAndStart(runnerId);
    const done = await call<ExecutionDto>("POST", `/executions/${execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "s", success: false, deniedActions: ["RunCommand"], result: "" },
    });
    expect(done.body.status).toBe("needs_approval");
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("WAITING_FOR_HUMAN");
  });

  it("moves failed runs to RETRYING, including failures before start", async () => {
    const { task, runnerId } = await setup();
    const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
    const done = await call<ExecutionDto>("POST", `/executions/${claim.execution.id}/complete`, {
      exitCode: null,
      terminal: { kind: "failed", reason: "workspace preparation failed" },
    });
    expect(done.body.status).toBe("failed");
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("RETRYING");
  });

  it("keeps a cancelled task cancelled when its execution finishes", async () => {
    const { task, runnerId } = await setup();
    const { execution } = await claimAndStart(runnerId);
    await call("POST", `/tasks/${task.id}/cancel`);
    await call("POST", `/executions/${execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "", success: true, deniedActions: [], result: "" },
    });
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("CANCELLED");
  });

  it("rejects out-of-order execution calls", async () => {
    const { runnerId } = await setup();
    const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
    // events before start
    expect((await call("POST", `/executions/${claim.execution.id}/events`, { events: [] })).status).toBe(409);
    await call("POST", `/executions/${claim.execution.id}/start`, { workspace: "/w", branch: "b" });
    // start twice
    expect((await call("POST", `/executions/${claim.execution.id}/start`, { workspace: "/w", branch: "b" })).status).toBe(
      409,
    );
  });

  it("pages project events with nextAfter", async () => {
    const { project } = await setup();
    const first = (await call<EventsPage>("GET", `/projects/${project.id}/events?limit=2`)).body;
    expect(first.events).toHaveLength(2);
    const rest = (await call<EventsPage>("GET", `/projects/${project.id}/events?after=${first.nextAfter}`)).body;
    expect(rest.events[0]!.seq).toBeGreaterThan(first.nextAfter);
    expect(rest.events.map((e) => e.type)).toContain("TaskStateChanged");
  });
});
