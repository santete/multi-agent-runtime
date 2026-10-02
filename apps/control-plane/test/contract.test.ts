import type { AgentDescriptor, ArtifactDto, ClaimResponse, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, migrate, Store } from "../src/index.js";

/** Collaboration contract (spec §62) and its acceptance criteria as a merge gate (spec §63). */

let db: Db;
let app: FastifyInstance;
let store: Store;
let runnerId: string;
let project: ProjectDto;

const provider: GitProvider = {
  async openPullRequest() {
    return { url: "https://github.com/o/r/pull/1", number: 1 };
  },
  async mergePullRequest() {
    return { status: "merged", sha: "abc" };
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
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  await call("PUT", `/projects/${project.id}/review`, { reviewAgents: ["reviewer"], autoApproveOnAgentReview: true });
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: [agent("dev"), agent("reviewer")] })).body.runnerId;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
});
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;

async function finish(c: ClaimResponse, result: object, deliver = true) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, { exitCode: 0, terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result } });
  if (!deliver) return;
  await call("POST", `/executions/${id}/validation`, { passed: true, steps: [], changedFiles: [] });
  await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: [] });
}
const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body.state;

const criteria = ["Refunding twice with the same request id refunds once", "README documents refunds"];

describe("collaboration contract", () => {
  it("is stored with the task, owned by its creator, and sent to the agent and the reviewer", async () => {
    const created = await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
      title: "Refunds",
      objective: "Add refunds",
      agent: "dev",
      inputs: ["docs/refund-policy.md"],
      constraints: ["Do not change the payment record shape"],
      expectedOutput: "refund() with tests",
      acceptanceCriteria: criteria,
    });
    expect(created.body).toMatchObject({
      contract: {
        inputs: ["docs/refund-policy.md"],
        constraints: ["Do not change the payment record shape"],
        expectedOutput: "refund() with tests",
        acceptanceCriteria: criteria,
      },
      owner: "local",
    });
    const work = await claim();
    expect(work.task.contract.acceptanceCriteria).toEqual(criteria);
    await finish(work, { summary: "done", criteria: criteria.map((c) => ({ criterion: c, met: true, evidence: "tests" })) });
    const review = await claim();
    expect(review.review?.contract.acceptanceCriteria).toEqual(criteria);
  });

  it("does not merge on an approval that leaves a criterion unchecked; merges once all are met (spec §63)", async () => {
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refunds", objective: "o", agent: "dev", acceptanceCriteria: criteria })).body;

    await finish(await claim(), { summary: "done" });
    // The reviewer approves but only checked the first criterion.
    await finish(await claim(), { verdict: "approve", summary: "fine", findings: [], criteria: [{ criterion: criteria[0], met: true, evidence: "test" }] }, false);
    expect(await state(task.id)).toBe("REWORK");
    const [overridden] = (await call<ArtifactDto[]>("GET", `/tasks/${task.id}/artifacts`)).body.filter((a) => a.type === "review_result");
    expect(overridden!.content).toMatchObject({
      verdict: "request_changes",
      findings: [{ severity: "blocker", message: `Acceptance criterion not met: ${criteria[1]} (not reported)` }],
    });

    await store.sweep();
    const rework = await claim();
    expect(rework.rework?.kind).toBe("review");
    await finish(rework, { summary: "documented" });
    await finish(await claim(), { verdict: "approve", summary: "fine", findings: [], criteria: criteria.map((c) => ({ criterion: c, met: true, evidence: "checked" })) }, false);
    expect(await state(task.id)).toBe("APPROVED");
    // The reviewed task shows the reviewer's check of each criterion.
    const latest = (await call<ArtifactDto[]>("GET", `/tasks/${task.id}/artifacts`)).body.filter((a) => a.type === "review_result").at(-1)!;
    expect(latest.content.criteria).toEqual(criteria.map((c) => ({ criterion: c, met: true, evidence: "checked" })));
    await store.processMergeQueue();
    expect(await state(task.id)).toBe("COMPLETED");
  });

  it("tells the reviewer what people decided, which overrides the contract", async () => {
    const task = (
      await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
        title: "t",
        objective: "o",
        agent: "dev",
        constraints: ["Do not modify README.md."],
        acceptanceCriteria: ["README.md documents it."],
      })
    ).body;
    // The agent spots the conflict and asks the owner.
    await finish(await claim(), { summary: "blocked", openQuestions: [{ question: "Allow the README update?", options: ["yes", "no"], context: "conflict" }] }, false);
    expect(await state(task.id)).toBe("WAITING_FOR_HUMAN");
    const [decision] = (await call<Array<{ id: string }>>("GET", `/decisions?taskId=${task.id}`)).body;
    await call("POST", `/decisions/${decision!.id}/answer`, { answer: "Yes, the README constraint is lifted." });

    await finish(await claim(), { summary: "documented" });
    const review = await claim();
    expect(review.review?.decisions).toEqual([{ question: "Allow the README update?", answer: "Yes, the README constraint is lifted.", answeredBy: "local" }]);
  });

  it("leaves tasks without criteria as before", async () => {
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "dev" })).body;
    expect(task.contract).toEqual({ inputs: [], constraints: [], expectedOutput: "", acceptanceCriteria: [] });
    await finish(await claim(), { summary: "done" });
    await finish(await claim(), { verdict: "approve", summary: "fine", findings: [], criteria: [] }, false);
    expect(await state(task.id)).toBe("APPROVED");
  });
});
