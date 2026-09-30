import type { AgentDescriptor, ClaimResponse, EventsPage, ExecutionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "../src/index.js";

/** M3: validation, rework context and delivery (pull requests). */

let db: Db;
let app: FastifyInstance;
let store: Store;

const opened: Array<{ head: string; base: string; title: string; body: string; repoUrl: string }> = [];
let providerFails = false;
const provider: GitProvider = {
  async openPullRequest(req) {
    if (providerFails) throw new Error("GitHub 403");
    opened.push(req);
    return { url: `https://github.com/o/r/pull/${opened.length}`, number: opened.length };
  },
};

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.query("truncate events, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db, { gitProvider: provider, leaseSeconds: 0.05 });
  app = buildApp(store);
  opened.length = 0;
  providerFails = false;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const descriptor: AgentDescriptor = {
  id: "shell",
  adapter: "generic-cli",
  capabilities: { pause: "none", resume: true, approval: "none", structuredOutput: true, streaming: true, costReporting: false },
};

const step = (passed: boolean, outputTail = "ok") => ({
  name: "test",
  command: "npm test",
  passed,
  exitCode: passed ? 0 : 1,
  durationMs: 1200,
  outputTail,
});
const passing = { passed: true, steps: [step(true)], changedFiles: ["src/refund.ts"] };
const failing = { passed: false, steps: [step(false, "Expected 1 refund, got 2")], changedFiles: ["src/refund.ts"] };

async function setup(maxAttempts?: number) {
  const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "Payment", repoUrl: "/tmp/repo" })).body;
  const task = (
    await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
      title: "Refund",
      objective: "Implement refunds",
      agent: "shell",
      ...(maxAttempts && { maxAttempts }),
    })
  ).body;
  const { runnerId } = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r1", agents: [descriptor] })).body;
  return { project, task, runnerId };
}

/** Claims the next task, starts it and reports a successful agent run with a handoff. */
async function agentDone(runnerId: string) {
  const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${claim.execution.id}/start`, { workspace: "/ws", branch: `task/${claim.task.key}` });
  await call("POST", `/executions/${claim.execution.id}/complete`, {
    exitCode: 0,
    terminal: {
      kind: "completed",
      sessionId: "s-1",
      success: true,
      deniedActions: [],
      result: {
        summary: "Added refunds",
        changes: ["src/refund.ts"],
        decisions: ["idempotency key per refund request"],
        knownIssues: [],
        remainingWork: [],
      },
    },
  });
  return claim;
}

const state = async (taskId: string) => (await call<TaskDto>("GET", `/tasks/${taskId}`)).body;
const execution = async (id: string) => (await call<ExecutionDto>("GET", `/executions/${id}`)).body;
const eventTypes = async (taskId: string) =>
  (await call<EventsPage>("GET", `/tasks/${taskId}/events?limit=1000`)).body.events.map((e) => e.type);

describe("project validation config", () => {
  it("is stored on create and can be replaced", async () => {
    const created = await call<ProjectDto>("POST", "/projects", {
      key: "VAL",
      name: "v",
      repoUrl: "/r",
      validation: [{ name: "build", command: "npm run build" }],
    });
    expect(created.body.validation).toEqual([{ name: "build", command: "npm run build" }]);
    const res = await call<ProjectDto>("PUT", `/projects/${created.body.id}/validation`, [{ name: "test", command: "npm test" }]);
    expect(res.body.validation).toEqual([{ name: "test", command: "npm test" }]);
    expect((await call("PUT", `/projects/${created.body.id}/validation`, [{ name: "" }])).status).toBe(400);
  });
});

describe("validation and delivery", () => {
  it("passing validation moves the task to REVIEW and opens a pull request on delivery", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);

    const v = await call<{ deliver: boolean }>("POST", `/executions/${claim.execution.id}/validation`, passing);
    expect(v.body).toEqual({ deliver: true });
    expect((await state(task.id)).state).toBe("REVIEW");
    expect((await execution(claim.execution.id)).status).toBe("delivering");

    const d = await call<{ pullRequest: { url: string } }>("POST", `/executions/${claim.execution.id}/delivery`, {
      branch: "task/PAY-1",
      commitSha: "abc1234",
      changedFiles: ["src/refund.ts"],
    });
    expect(d.body.pullRequest.url).toBe("https://github.com/o/r/pull/1");
    expect(opened[0]).toMatchObject({ head: "task/PAY-1", base: "main", title: "PAY-1: Refund", repoUrl: "/tmp/repo" });
    expect(opened[0]!.body).toContain("Added refunds");
    expect(opened[0]!.body).toContain("idempotency key per refund request");
    expect(opened[0]!.body).toContain("| test | `npm test` | ✅ pass |");

    expect(await state(task.id)).toMatchObject({ state: "REVIEW", pullRequestUrl: "https://github.com/o/r/pull/1" });
    expect(await execution(claim.execution.id)).toMatchObject({ status: "succeeded", leaseExpiresAt: null });
    expect(await eventTypes(task.id)).toEqual(
      expect.arrayContaining(["ArtifactCreated", "ValidationPassed", "BranchPushed", "PullRequestOpened"]),
    );
    const artifacts = (await call<Array<{ type: string }>>("GET", `/tasks/${task.id}/artifacts`)).body;
    expect(artifacts.map((a) => a.type)).toEqual(["handoff", "validation_result"]);
  });

  it("failing validation sends the task to REWORK; the next attempt gets the failure and the session", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    const v = await call<{ deliver: boolean }>("POST", `/executions/${claim.execution.id}/validation`, failing);
    expect(v.body).toEqual({ deliver: false });
    expect((await state(task.id)).state).toBe("REWORK");
    expect((await execution(claim.execution.id)).status).toBe("failed");

    expect(await store.sweep()).toMatchObject({ requeued: 1 });
    const retry = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
    expect(retry.execution.attempt).toBe(2);
    expect(retry.rework).toEqual({ attempt: 1, reason: "validation failed: test", validation: failing });
    expect(retry.resume).toEqual({ sessionId: "s-1", runnerId });
  });

  it("blocks the task after maxAttempts failed validations", async () => {
    const { task, runnerId } = await setup(1);
    const claim = await agentDone(runnerId);
    await call("POST", `/executions/${claim.execution.id}/validation`, failing);
    expect(await store.sweep()).toMatchObject({ blocked: 1 });
    expect((await state(task.id)).state).toBe("BLOCKED");
  });

  it("skips the pull request when nothing changed", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await call("POST", `/executions/${claim.execution.id}/validation`, { ...passing, changedFiles: [] });
    const d = await call<{ pullRequest: null }>("POST", `/executions/${claim.execution.id}/delivery`, {
      branch: "task/PAY-1",
      commitSha: null,
      changedFiles: [],
    });
    expect(d.body.pullRequest).toBeNull();
    expect(opened).toHaveLength(0);
    const events = (await call<EventsPage>("GET", `/tasks/${task.id}/events?limit=1000`)).body.events;
    expect(events.find((e) => e.type === "PullRequestSkipped")!.payload).toEqual({ reason: "no file changes" });
    expect(events.map((e) => e.type)).toContain("NoChanges");
  });

  it("records a provider failure and leaves the task in REVIEW without a PR", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await call("POST", `/executions/${claim.execution.id}/validation`, passing);
    providerFails = true;
    await call("POST", `/executions/${claim.execution.id}/delivery`, {
      branch: "task/PAY-1",
      commitSha: "abc1234",
      changedFiles: ["a"],
    });
    expect(await state(task.id)).toMatchObject({ state: "REVIEW", pullRequestUrl: null });
    expect(await eventTypes(task.id)).toContain("PullRequestFailed");
  });

  it("records a push failure reported by the runner", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await call("POST", `/executions/${claim.execution.id}/validation`, passing);
    const d = await call<{ pullRequest: null }>("POST", `/executions/${claim.execution.id}/delivery`, {
      branch: "task/PAY-1",
      commitSha: null,
      changedFiles: [],
      error: "rejected: non-fast-forward",
    });
    expect(d.body.pullRequest).toBeNull();
    expect((await execution(claim.execution.id)).status).toBe("failed");
    expect((await state(task.id)).state).toBe("REVIEW");
    expect(await eventTypes(task.id)).toContain("DeliveryFailed");
  });

  it("does not deliver a task cancelled during validation", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await call("POST", `/tasks/${task.id}/cancel`);
    const v = await call<{ deliver: boolean }>("POST", `/executions/${claim.execution.id}/validation`, passing);
    expect(v.body).toEqual({ deliver: false });
    expect((await execution(claim.execution.id)).status).toBe("cancelled");
    expect((await state(task.id)).state).toBe("CANCELLED");
  });
});

describe("runner lost after the agent finished", () => {
  it("retries when lost while validating", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await store.sweep()).toMatchObject({ lost: 1, requeued: 1 });
    expect((await execution(claim.execution.id)).status).toBe("lost");
    expect((await state(task.id)).state).toBe("READY");
  });

  it("keeps REVIEW and records DeliveryLost when lost while delivering", async () => {
    const { task, runnerId } = await setup();
    const claim = await agentDone(runnerId);
    await call("POST", `/executions/${claim.execution.id}/validation`, passing);
    await new Promise((r) => setTimeout(r, 100));
    expect(await store.sweep()).toMatchObject({ lost: 1, requeued: 0 });
    expect((await state(task.id)).state).toBe("REVIEW");
    expect(await eventTypes(task.id)).toContain("DeliveryLost");
  });
});
