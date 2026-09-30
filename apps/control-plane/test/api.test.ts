import type { AgentDescriptor, ClaimResponse, EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

let db: Db;
let app: FastifyInstance;

const descriptor = (id: string): AgentDescriptor => ({
  id,
  adapter: "generic-cli",
  capabilities: {
    pause: "none",
    resume: false,
    approval: "none",
    structuredOutput: false,
    streaming: true,
    costReporting: false,
  },
});

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
  const { runnerId } = (
    await call<{ runnerId: string }>("POST", "/runners/register", { name: "r1", agents: [descriptor("shell")] })
  ).body;
  return { project, task, runnerId };
}

async function claimAndStart(runnerId: string, workspace = "/ws/PAY-1") {
  const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${claim.execution.id}/start`, { workspace, branch: "task/PAY-1" });
  return claim;
}

const completed = (success: boolean, sessionId = "", deniedActions: string[] = []) => ({
  exitCode: 0,
  terminal: { kind: "completed", sessionId, success, deniedActions, result: "" },
});

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
    // Still leased: the runner validates next.
    expect(done.body).toMatchObject({ status: "validating", exitCode: 0, sessionId: "sess-1" });
    expect(done.body.leaseExpiresAt).not.toBeNull();
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("VALIDATING");

    const log = (await call<EventsPage>("GET", `/executions/${execution.id}/events`)).body.events;
    expect(log.map((e) => e.type)).toEqual([
      "ExecutionAssigned",
      "ExecutionStarted",
      "AgentEvent",
      "AgentEvent",
      "AgentFinished",
      "ArtifactCreated",
    ]);
    const [handoff] = (await call<Array<{ type: string; content: object }>>("GET", `/tasks/${task.id}/artifacts`)).body;
    expect(handoff).toMatchObject({ type: "handoff", content: { summary: "hi", changes: [] } });
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

describe("agent registry", () => {
  it("re-registering the same runner name keeps the id and updates agents", async () => {
    const first = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "laptop", agents: [descriptor("a")] }))
      .body.runnerId;
    const again = (
      await call<{ runnerId: string }>("POST", "/runners/register", { name: "laptop", agents: [descriptor("a"), descriptor("b")] })
    ).body.runnerId;
    expect(again).toBe(first);
    const runners = (await call<Array<{ id: string; online: boolean; agents: AgentDescriptor[] }>>("GET", "/runners"))
      .body;
    expect(runners).toHaveLength(1);
    expect(runners[0]).toMatchObject({ id: first, online: true });
    expect(runners[0]!.agents.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("rejects agents without capabilities", async () => {
    expect((await call("POST", "/runners/register", { name: "x", agents: [{ id: "a", adapter: "b" }] })).status).toBe(
      400,
    );
  });
});

describe("heartbeat and cancellation", () => {
  it("renews the lease and asks the runner to stop after cancel", async () => {
    const { task, runnerId } = await setup();
    const { execution } = await claimAndStart(runnerId);
    const hb = (await call<{ cancel: boolean; leaseExpiresAt: string }>("POST", `/executions/${execution.id}/heartbeat`))
      .body;
    expect(hb.cancel).toBe(false);
    expect(Date.parse(hb.leaseExpiresAt)).toBeGreaterThan(Date.now());

    await call("POST", `/tasks/${task.id}/cancel`);
    expect((await call<{ cancel: boolean }>("POST", `/executions/${execution.id}/heartbeat`)).body.cancel).toBe(true);

    const done = await call<ExecutionDto>("POST", `/executions/${execution.id}/complete`, {
      exitCode: null,
      terminal: { kind: "failed", reason: "cancelled" },
    });
    expect(done.body.status).toBe("cancelled");
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("CANCELLED");
    // A finished execution always answers "stop".
    expect((await call<{ cancel: boolean }>("POST", `/executions/${execution.id}/heartbeat`)).body.cancel).toBe(true);
  });
});

describe("leases, retries and resume", () => {
  it("marks executions of a vanished runner as lost and requeues the task", async () => {
    const shortLease = new Store(db, { leaseSeconds: 0.05 });
    await app.close();
    app = buildApp(shortLease);
    const { task, runnerId } = await setup();
    const { execution } = await claimAndStart(runnerId);
    await call("POST", `/executions/${execution.id}/events`, { events: [{ kind: "session_started", sessionId: "s-1" }] });
    await new Promise((r) => setTimeout(r, 100));

    // One sweep: the execution is lost, the task goes RETRYING and is immediately requeued.
    expect(await shortLease.sweep()).toEqual({ lost: 1, requeued: 1, blocked: 0 });
    expect((await call<ExecutionDto>("GET", `/executions/${execution.id}`)).body.status).toBe("lost");
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("READY");
    const timeline = (await call<EventsPage>("GET", `/tasks/${task.id}/events`)).body.events
      .filter((e) => e.type === "TaskStateChanged")
      .map((e) => e.payload.to);
    expect(timeline.slice(-2)).toEqual(["RETRYING", "READY"]);
    // A late completion from the lost runner is rejected.
    expect((await call("POST", `/executions/${execution.id}/complete`, completed(true))).status).toBe(409);

    // The next attempt learns which session it can resume.
    const retry = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
    expect(retry.execution.attempt).toBe(2);
    expect(retry.resume).toEqual({ sessionId: "s-1", runnerId });
  });

  it("blocks a task once maxAttempts is used up", async () => {
    const { project, runnerId } = await setup();
    const task = (
      await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
        title: "flaky",
        objective: "x",
        agent: "shell",
        maxAttempts: 1,
      })
    ).body;
    await call("POST", `/tasks/${(await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body[0]!.id}/cancel`);
    const claim = await claimAndStart(runnerId);
    expect(claim.task.id).toBe(task.id);
    await call("POST", `/executions/${claim.execution.id}/complete`, {
      exitCode: 1,
      terminal: { kind: "failed", reason: "boom" },
    });
    const store = new Store(db);
    expect(await store.sweep()).toEqual({ lost: 0, requeued: 0, blocked: 1 });
    expect((await call<TaskDto>("GET", `/tasks/${task.id}`)).body.state).toBe("BLOCKED");
  });
});

describe("tool-check (policy hook endpoint)", () => {
  async function running() {
    const { runnerId } = await setup();
    return claimAndStart(runnerId, "C:\ws\PAY-1");
  }
  const check = (id: string, token: string | undefined, body: object) =>
    app.inject({
      method: "POST",
      url: `/executions/${id}/tool-check`,
      payload: body,
      ...(token && { headers: { "x-mar-execution-token": token } }),
    });

  it("requires the execution token", async () => {
    const claim = await running();
    expect((await check(claim.execution.id, undefined, { tool: "Bash", input: {} })).statusCode).toBe(401);
    expect((await check(claim.execution.id, "wrong", { tool: "Bash", input: {} })).statusCode).toBe(401);
  });

  it("evaluates policy against the execution workspace and audits the decision", async () => {
    const claim = await running();
    const allow = await check(claim.execution.id, claim.executionToken, {
      tool: "Write",
      input: { file_path: "C:\ws\PAY-1\src\a.ts" },
    });
    expect(allow.json()).toMatchObject({ decision: "allow", risk: "LOW" });
    const deny = await check(claim.execution.id, claim.executionToken, {
      tool: "PowerShell",
      input: { command: "git push origin main" },
    });
    expect(deny.json()).toMatchObject({ decision: "deny", risk: "CRITICAL" });

    const audit = (await call<EventsPage>("GET", `/executions/${claim.execution.id}/events`)).body.events.filter(
      (e) => e.type === "ToolCallChecked",
    );
    expect(audit.map((e) => e.payload.decision)).toEqual(["allow", "deny"]);
  });

  it("never marks an execution succeeded after a policy denial, whatever the agent reports", async () => {
    const claim = await running();
    await check(claim.execution.id, claim.executionToken, { tool: "Bash", input: { command: "git push" } });
    const done = await call<ExecutionDto>("POST", `/executions/${claim.execution.id}/complete`, completed(true));
    expect(done.body.status).toBe("needs_approval");
    expect((await call<TaskDto>("GET", `/tasks/${claim.task.id}`)).body.state).toBe("WAITING_FOR_HUMAN");
  });

  it("denies tool calls once the execution is no longer running", async () => {
    const claim = await running();
    await call("POST", `/executions/${claim.execution.id}/complete`, completed(true));
    const res = await check(claim.execution.id, claim.executionToken, { tool: "Read", input: {} });
    expect(res.json()).toMatchObject({ decision: "deny" });
  });
});

describe("API token", () => {
  it("protects the API but leaves health and tool-check to their own rules", async () => {
    const secured = buildApp(new Store(db), { apiToken: "s3cret" });
    try {
      expect((await secured.inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
      expect(
        (await secured.inject({ method: "GET", url: "/projects", headers: { authorization: "Bearer wrong" } }))
          .statusCode,
      ).toBe(401);
      expect(
        (await secured.inject({ method: "GET", url: "/projects", headers: { authorization: "Bearer s3cret" } }))
          .statusCode,
      ).toBe(200);
      expect((await secured.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      const toolCheck = await secured.inject({
        method: "POST",
        url: "/executions/00000000-0000-4000-8000-000000000000/tool-check",
        payload: { tool: "Bash", input: {} },
      });
      expect(toolCheck.statusCode).toBe(401); // no execution token, but not blocked by the API token hook
      expect(toolCheck.json()).toEqual({ error: "unauthorized" });
    } finally {
      await secured.close();
    }
  });
});
