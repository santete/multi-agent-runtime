import type { AgentDescriptor, ClaimResponse, ProductMetrics, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "../src/index.js";

/** Product success metrics (spec §64). */

let db: Db;
let app: FastifyInstance;
let store: Store;

const provider: GitProvider = {
  async openPullRequest() {
    return { url: "https://github.com/o/r/pull/1", number: 1 };
  },
  async mergePullRequest() {
    return { status: "merged", sha: "abc" };
  },
  async pullRequestStatus() {
    return { headSha: "h", behindBase: false, checks: { state: "success", runs: [] } };
  },
};

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db, { gitProvider: provider });
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

/** Runs a claimed execution: agent done, validation with the given result, delivery when it passed. */
async function run(c: ClaimResponse, passed = true) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/events`, { events: [{ kind: "session_started", sessionId: `s-${c.task.key}` }] });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: `s-${c.task.key}`, success: true, deniedActions: [], result: { summary: "done" } },
  });
  await call("POST", `/executions/${id}/validation`, { passed, steps: [], changedFiles: [] });
  if (passed) await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: [] });
}
const workspaceFailure = (c: ClaimResponse) =>
  call("POST", `/executions/${c.execution.id}/complete`, { exitCode: null, terminal: { kind: "failed", reason: "workspace preparation failed: disk full" } });

describe("success metrics", () => {
  it("measures collaboration, engineering, automation, reliability and the platform", async () => {
    const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
    runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: [agent("dev"), agent("other")] })).body.runnerId;
    const create = async (body: object) =>
      (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { objective: "o", maxAttempts: 2, ...body })).body;
    const a = await create({ title: "A", agent: "dev" });
    const b = await create({ title: "B", agent: "other", dependsOn: [a.id] });
    const c = await create({ title: "C", agent: "dev" });

    // A: delivered, reviewed by a person, merged.
    await run(await claim());
    // C: the workspace breaks twice; blocked.
    await workspaceFailure(await claim());
    await call("POST", `/tasks/${a.id}/review`, { decision: "approve" });
    await store.processMergeQueue();
    await store.sweep();
    // B (unblocked by A's merge) and C's second attempt, in whatever order the scheduler takes them.
    const claims = [await claim(), await claim()];
    const bClaim = claims.find((x) => x.task.id === b.id)!;
    const cClaim = claims.find((x) => x.task.id === c.id)!;
    await workspaceFailure(cClaim);
    // B: validation fails, the agent reworks it on its session, then merged.
    await run(bClaim, false);
    await store.sweep();
    await run(await claim());
    await call("POST", `/tasks/${b.id}/review`, { decision: "approve" });
    await store.processMergeQueue();

    const states = Object.fromEntries((await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.map((t) => [t.title, t.state]));
    expect(states).toEqual({ A: "COMPLETED", B: "COMPLETED", C: "BLOCKED" });

    const m = (await call<ProductMetrics>("GET", `/metrics?projectId=${project.id}&days=7`)).body;
    const r = (x: { numerator: number; denominator: number }) => `${x.numerator}/${x.denominator}`;
    expect({
      handoff: r(m.collaboration.handoffSuccess),
      context: r(m.collaboration.contextReuse),
      a2a: r(m.collaboration.agentToAgentHandoff),
      success: r(m.engineering.taskSuccess),
      validation: r(m.engineering.validationPass),
      rework: r(m.engineering.rework),
      rejection: r(m.engineering.reviewRejection),
      intervention: r(m.automation.humanIntervention),
      autoResolution: r(m.automation.autoResolution),
      autonomous: r(m.automation.autonomousCompletion),
      recovery: r(m.reliability.failureRecovery),
      resume: r(m.reliability.resumeSuccess),
      workspace: r(m.reliability.workspaceFailure),
    }).toEqual({
      handoff: "3/5", // A, B twice; C's two runs never reached the agent
      context: "2/5", // B's runs started from A's handoff
      a2a: "1/1", // B continued dev's work as "other" and got merged
      success: "2/3",
      validation: "2/3",
      rework: "1/3",
      rejection: "0/2",
      intervention: "1/3", // C ended blocked
      autoResolution: "1/2", // B fixed itself; C did not
      autonomous: "0/2", // both merged after a person reviewed them
      recovery: "0/1",
      resume: "1/1", // B's second run resumed its session
      workspace: "2/5",
    });
    expect(m.engineering.taskSuccess.value).toBeCloseTo(2 / 3);
    expect(m.engineering.meanCompletionMs).toBeGreaterThanOrEqual(0);
    expect(m.platform).toMatchObject({ agentsIntegrated: 2, runnersOnline: 1, concurrentSessions: 0, projectsManaged: 1 });
    expect(m.platform.peakConcurrentSessions).toBeGreaterThanOrEqual(1);
    expect(m.platform.meanQueueWaitMs).toBeGreaterThanOrEqual(0);
    expect(m.platform.meanDispatchMs).toBeGreaterThanOrEqual(0);
  });

  it("counts work merged on an agent review as autonomous, and leaves tasks for people out", async () => {
    const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
    await app.inject({ method: "PUT", url: `/projects/${project.id}/review`, payload: { reviewAgents: ["other"], autoApproveOnAgentReview: true } });
    runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: [agent("dev"), agent("other")] })).body.runnerId;
    const decide = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Decide", objective: "o", agent: "human" })).body;
    await call("POST", `/tasks/${decide.id}/done`, { summary: "EUR by default" });
    await call("POST", `/projects/${project.id}/tasks`, { title: "Build", objective: "o", agent: "dev", dependsOn: [decide.id] });

    await run(await claim());
    const review = await claim();
    expect(review.task.kind).toBe("review");
    await call("POST", `/executions/${review.execution.id}/start`, { workspace: "/ws", branch: "b" });
    await call("POST", `/executions/${review.execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "r", success: true, deniedActions: [], result: { verdict: "approve", summary: "fine", findings: [] } },
    });
    await store.processMergeQueue();

    const m = (await call<ProductMetrics>("GET", `/metrics?projectId=${project.id}`)).body;
    expect(m.engineering.taskSuccess).toMatchObject({ numerator: 1, denominator: 1 });
    expect(m.automation.autonomousCompletion).toMatchObject({ numerator: 1, denominator: 1 });
    expect(m.automation.humanIntervention).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it("reports null rates when nothing was measured", async () => {
    const m = (await call<ProductMetrics>("GET", "/metrics")).body;
    expect(m.engineering.taskSuccess).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(m.days).toBe(30);
    expect((await call("GET", "/metrics?days=0")).status).toBe(400);
  });
});
