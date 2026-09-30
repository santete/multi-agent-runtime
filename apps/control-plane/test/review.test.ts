import type { AgentDescriptor, ArtifactDto, ClaimResponse, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "../src/index.js";

/** Cross-agent review (spec §30): another agent reviews each delivered task. */

let db: Db;
let app: FastifyInstance;
let store: Store;
const comments: Array<{ number: number; body: string }> = [];
const provider: GitProvider = {
  async openPullRequest() {
    return { url: "https://github.com/o/r/pull/9", number: 9 };
  },
  async mergePullRequest() {
    return { status: "merged", sha: "abc" };
  },
  async commentOnPullRequest(req) {
    comments.push({ number: req.number, body: req.body });
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
  comments.length = 0;
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

async function setup(policy: { reviewAgents: string[]; autoApproveOnAgentReview?: boolean }) {
  const project = (
    await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", ...policy })
  ).body;
  const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refund", objective: "Add refunds", agent: "claude" }))
    .body;
  const runnerId = (
    await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("claude"), agent("codex")] })
  ).body.runnerId;
  return { project, task, runnerId };
}

const claim = async (runnerId: string) => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;

/** Runs a work task through to delivery (REVIEW). */
async function deliver(runnerId: string) {
  const c = await claim(runnerId);
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: {
      kind: "completed",
      sessionId: "s-author",
      success: true,
      deniedActions: [],
      result: { summary: "Added refund()", changes: ["src/refund.js"], decisions: [], knownIssues: [], remainingWork: [] },
    },
  });
  await call("POST", `/executions/${id}/validation`, { passed: true, steps: [], changedFiles: ["src/refund.js"] });
  await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: ["src/refund.js"] });
  return c;
}

/** The reviewer answers with the given review. */
async function review(runnerId: string, result: unknown) {
  const c = await claim(runnerId);
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws-review", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s-reviewer", success: true, deniedActions: [], result },
  });
  return c;
}

const changes = {
  verdict: "request_changes",
  summary: "Refunds can exceed the charge.",
  findings: [{ severity: "blocker", file: "src/refund.js", line: 12, message: "check the refunded total" }],
};
const approve = { verdict: "approve", summary: "Looks correct.", findings: [] };

describe("agent review", () => {
  it("creates a review task for another agent with the delivered branch as context", async () => {
    const { project, task, runnerId } = await setup({ reviewAgents: ["claude", "codex"] });
    await deliver(runnerId);
    expect((await state(task.id)).state).toBe("REVIEW");

    const tasks = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body;
    const reviewTask = tasks.find((t) => t.kind === "review")!;
    expect(reviewTask).toMatchObject({ key: "PAY-2", agent: "codex", reviewOf: task.id, state: "READY", title: "Review PAY-1: Refund" });

    const c = await claim(runnerId);
    expect(c.task.id).toBe(reviewTask.id);
    expect(c.review).toMatchObject({
      taskKey: "PAY-1",
      branch: "task/PAY-1",
      baseBranch: "main",
      author: "claude",
      pullRequestUrl: "https://github.com/o/r/pull/9",
      handoff: expect.objectContaining({ summary: "Added refund()" }),
      validation: expect.objectContaining({ passed: true }),
    });
  });

  it("sends the task back to rework with the findings when changes are requested", async () => {
    const { task, runnerId } = await setup({ reviewAgents: ["codex"] });
    await deliver(runnerId);
    const r = await review(runnerId, changes);

    expect((await state(r.task.id)).state).toBe("COMPLETED");
    expect((await state(task.id)).state).toBe("REWORK");
    expect(comments).toEqual([{ number: 9, body: expect.stringContaining("Review by agent codex: changes requested.") }]);

    await store.sweep();
    const again = await claim(runnerId);
    expect(again.task.id).toBe(task.id);
    expect(again.rework).toMatchObject({ kind: "review", comment: expect.stringContaining("[blocker] src/refund.js:12 — check the refunded total") });
    expect(again.resume?.sessionId).toBe("s-author");
  });

  it("leaves an approved task for a human unless auto-approval is on", async () => {
    const manual = await setup({ reviewAgents: ["codex"] });
    await deliver(manual.runnerId);
    await review(manual.runnerId, approve);
    expect((await state(manual.task.id)).state).toBe("REVIEW");
    const artifacts = (await call<ArtifactDto[]>("GET", `/tasks/${manual.task.id}/artifacts`)).body;
    expect(artifacts.find((a) => a.type === "review_result")!.content).toMatchObject({ decision: "approve", reviewer: "agent codex" });
  });

  it("queues the merge on an agent approval when auto-approval is on", async () => {
    const { task, runnerId } = await setup({ reviewAgents: ["codex"], autoApproveOnAgentReview: true });
    await deliver(runnerId);
    await review(runnerId, approve);
    expect((await state(task.id)).state).toBe("APPROVED");
    await store.processMergeQueue();
    expect((await state(task.id)).state).toBe("COMPLETED");
  });

  it("retries a reviewer that returned no usable review instead of approving", async () => {
    const { task, runnerId } = await setup({ reviewAgents: ["codex"] });
    await deliver(runnerId);
    const r = await review(runnerId, "LGTM!");
    expect((await state(r.task.id)).state).toBe("RETRYING");
    expect((await state(task.id)).state).toBe("REVIEW");
  });

  it("skips agent review when no reviewer differs from the author", async () => {
    const { project, runnerId } = await setup({ reviewAgents: ["claude"] });
    await deliver(runnerId);
    const tasks = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body;
    expect(tasks.filter((t) => t.kind === "review")).toEqual([]);
  });

  it("keeps a human decision taken before the agent review finished", async () => {
    const { task, runnerId } = await setup({ reviewAgents: ["codex"] });
    await deliver(runnerId);
    await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });
    await review(runnerId, changes);
    expect((await state(task.id)).state).toBe("APPROVED");
    const types = (await call<EventsPage>("GET", `/tasks/${task.id}/events?limit=1000`)).body.events.map((e) => e.type);
    expect(types).toContain("AgentReviewCompleted");
  });

  it("stores the review policy", async () => {
    const { project } = await setup({ reviewAgents: [] });
    const res = await call<ProjectDto>("PUT", `/projects/${project.id}/review`, { reviewAgents: ["codex"], autoApproveOnAgentReview: true });
    expect(res.body).toMatchObject({ reviewAgents: ["codex"], autoApproveOnAgentReview: true });
  });
});
