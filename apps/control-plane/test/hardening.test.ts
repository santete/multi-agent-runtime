import type { ApprovalDto, ClaimResponse, EventDto, ProjectDto, RunnerDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** M5 hardening: roles and audit, live event stream, worktree GC, restart recovery. */

const TOKENS = {
  owner: "owner-token-000000001",
  senior: "senior-token-00000001",
  member: "member-token-00000001",
  viewer: "viewer-token-00000001",
  runner: "runner-token-00000001",
};
const users = [
  { name: "olivia", role: "owner" as const, token: TOKENS.owner },
  { name: "sam", role: "senior" as const, token: TOKENS.senior },
  { name: "mia", role: "member" as const, token: TOKENS.member },
  { name: "vic", role: "viewer" as const, token: TOKENS.viewer },
  { name: "box-1", role: "runner" as const, token: TOKENS.runner },
];

let db: Db;
let store: Store;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db);
  app = buildApp(store, { users, streamPollMs: 50 });
});
afterEach(() => app.close());

async function as<T>(who: keyof typeof TOKENS | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(who && { headers: { authorization: `Bearer ${TOKENS[who]}` } }),
    ...(payload !== undefined && { payload: payload as object }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const descriptor = {
  id: "dev",
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
};

async function setup() {
  const project = (await as<ProjectDto>("owner", "POST", "/projects", { key: "PAY", name: "p", repoUrl: "/r" })).body;
  const task = (await as<TaskDto>("member", "POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "dev" })).body;
  const runnerId = (await as<{ runnerId: string }>("runner", "POST", "/runners/register", { name: "box-1", agents: [descriptor] })).body.runnerId;
  return { project, task, runnerId };
}

async function running(runnerId: string) {
  const claim = (await as<ClaimResponse>("runner", "POST", `/runners/${runnerId}/claim`)).body;
  await as("runner", "POST", `/executions/${claim.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
  return claim;
}

describe("roles", () => {
  it("rejects missing or unknown tokens and reports who is calling", async () => {
    expect((await as(null, "GET", "/projects")).status).toBe(401);
    expect((await app.inject({ method: "GET", url: "/projects", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await as("viewer", "GET", "/me")).body).toEqual({ name: "vic", role: "viewer" });
    expect((await as(null, "GET", "/health")).status).toBe(200);
  });

  it("enforces the minimum role per route", async () => {
    // Only owners create projects.
    expect((await as("member", "POST", "/projects", { key: "X", name: "x", repoUrl: "/r" })).status).toBe(403);
    const { project, task } = await setup();
    // Viewers read but do not act.
    expect((await as("viewer", "GET", `/projects/${project.id}/tasks`)).status).toBe(200);
    expect((await as("viewer", "POST", `/tasks/${task.id}/cancel`)).status).toBe(403);
    // Humans cannot use the runner protocol, runners cannot act as humans.
    expect((await as("senior", "POST", "/runners/register", { name: "x", agents: [] })).status).toBe(403);
    expect((await as("runner", "POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "dev" })).status).toBe(403);
    expect((await as("runner", "GET", "/projects")).status).toBe(403);
  });

  it("records who acted in the event log", async () => {
    const { task } = await setup();
    await as("member", "POST", `/tasks/${task.id}/cancel`);
    const events = (await as<{ events: EventDto[] }>("viewer", "GET", `/tasks/${task.id}/events`)).body.events;
    expect(events.find((e) => e.type === "TaskCreated")!.payload.actor).toBe("mia");
    expect(events.find((e) => e.payload.to === "CANCELLED")!.payload.actor).toBe("mia");
  });

  it("requires a senior for HIGH risk approvals and audits the decision", async () => {
    const { runnerId } = await setup();
    const claim = await running(runnerId);
    await app.inject({
      method: "POST",
      url: `/executions/${claim.execution.id}/tool-check`,
      headers: { "x-mar-execution-token": claim.executionToken },
      payload: { tool: "Bash", input: { command: "curl https://example.com" } },
    });
    const [approval] = (await as<ApprovalDto[]>("viewer", "GET", "/approvals?status=pending")).body;
    expect(approval!.risk).toBe("HIGH");

    const denied = await as<{ message: string }>("member", "POST", `/approvals/${approval!.id}/approve`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("require role senior");

    const ok = await as<ApprovalDto>("senior", "POST", `/approvals/${approval!.id}/approve`, { comment: "fine" });
    expect(ok.body).toMatchObject({ status: "approved", decidedBy: "sam", comment: "fine" });
  });
});

describe("live event stream", () => {
  it("streams new events of a project as server-sent events", async () => {
    const { project } = await setup();
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const ac = new AbortController();
    const res = await fetch(`${base}/stream?projectId=${project.id}`, {
      headers: { authorization: `Bearer ${TOKENS.viewer}` },
      signal: ac.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The stream starts at "now": create an event after connecting.
    await reader.read();
    await as("member", "POST", `/projects/${project.id}/tasks`, { title: "live", objective: "o", agent: "dev" });
    while (!text.includes("TaskCreated")) text += decoder.decode((await reader.read()).value);
    ac.abort();
    const data = text.split("\n").find((l) => l.startsWith("data: ") && l.includes("TaskCreated"))!;
    expect(JSON.parse(data.slice(6))).toMatchObject({ type: "TaskCreated", projectId: project.id, payload: { title: "live" } });
    expect(text).toMatch(/^id: \d+$/m);
  });

  it("requires a token", async () => {
    expect((await as(null, "GET", "/stream")).status).toBe(401);
  });
});

describe("worktree GC and restart recovery", () => {
  it("tells runners which task worktrees belong to finished tasks", async () => {
    const { project, task, runnerId } = await setup();
    const other = (await as<TaskDto>("member", "POST", `/projects/${project.id}/tasks`, { title: "b", objective: "o", agent: "dev" })).body;
    await as("member", "POST", `/tasks/${task.id}/cancel`);
    const res = await as<string[]>("runner", "POST", `/runners/${runnerId}/gc`, { taskKeys: [task.key, other.key, "NOPE-1"] });
    expect(res.body).toEqual([task.key]);
  });

  it("renews active leases after a restart instead of declaring runners lost", async () => {
    await app.close();
    app = buildApp(new Store(db, { leaseSeconds: 0.05 }), { users });
    const { runnerId } = await setup();
    const claim = await running(runnerId);
    await new Promise((r) => setTimeout(r, 100)); // the control plane was "down" longer than the lease

    // Without the renewal the sweep would declare the execution lost.
    const restarted = new Store(db, { leaseSeconds: 60 });
    expect(await restarted.extendActiveLeases()).toBe(1);
    expect(await restarted.sweep()).toMatchObject({ lost: 0 });
    expect((await as<{ status: string }>("viewer", "GET", `/executions/${claim.execution.id}`)).body.status).toBe("running");
  });

  it("(control) an expired lease is declared lost when not renewed", async () => {
    await app.close();
    const shortLease = new Store(db, { leaseSeconds: 0.05 });
    app = buildApp(shortLease, { users });
    const { runnerId } = await setup();
    await running(runnerId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await shortLease.sweep()).toMatchObject({ lost: 1 });
  });

  it("lists what each runner is working on", async () => {
    const { runnerId } = await setup();
    const claim = await running(runnerId);
    const [runner] = (await as<RunnerDto[]>("viewer", "GET", "/runners")).body;
    expect(runner!.activeExecutions).toEqual([
      { executionId: claim.execution.id, taskId: claim.task.id, taskKey: "PAY-1", agent: "dev", status: "running", attempt: 1 },
    ]);
  });
});
