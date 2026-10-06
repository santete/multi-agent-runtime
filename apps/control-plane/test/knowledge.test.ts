import type { AgentDescriptor, ClaimResponse, KnowledgeDto, PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Shared knowledge base (spec §20, §21, §35). */

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

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: id,
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});

let project: ProjectDto;
let runnerId: string;

async function setup() {
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("claude")] })).body.runnerId;
}

const createTask = async (title: string) =>
  (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title, objective: title, agent: "claude" })).body;
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const knowledge = async (status?: string) =>
  (await call<KnowledgeDto[]>("GET", `/projects/${project.id}/knowledge${status ? `?status=${status}` : ""}`)).body;

const cents = { kind: "business_rule", title: "Amounts are integer cents", body: "Every amount in src/payments.js is an integer number of cents." };
const esm = { kind: "convention", title: "ES modules only", body: "The package is type: module; use import/export." };

/** Runs the claimed task's agent to a successful finish, reporting the given knowledge. */
async function finish(c: ClaimResponse, notes: unknown[], passed = true) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: {
      kind: "completed",
      sessionId: "s1",
      success: true,
      deniedActions: [],
      result: { summary: "done", changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: notes },
    },
  });
  await call("POST", `/executions/${id}/validation`, { passed, steps: [], changedFiles: [] });
  if (passed) await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: [] });
}

async function approveAndMerge(taskId: string) {
  await call("POST", `/tasks/${taskId}/review`, { decision: "approve" });
  await store.processMergeQueue();
  // No Git provider here: the branch is merged by a person.
  await call("POST", `/tasks/${taskId}/merged`);
}

describe("knowledge base", () => {
  beforeEach(setup);

  it("shares what an agent learned with later tasks once its work is merged", async () => {
    const first = await createTask("Refunds");
    const c = await claim();
    expect(c.knowledge).toBeUndefined();
    await finish(c, [cents]);

    expect(await knowledge()).toEqual([
      expect.objectContaining({ ...cents, status: "proposed", sourceTaskKey: "PAY-1", sourceAgent: "claude" }),
    ]);
    // Not shared before the work is merged.
    await createTask("Void");
    await approveAndMerge(first.id);
    expect(await knowledge("accepted")).toEqual([expect.objectContaining({ title: cents.title, decidedBy: "local" })]);

    const next = await claim();
    expect(next.task.key).toBe("PAY-2");
    expect(next.knowledge).toEqual([{ ...cents, source: "PAY-1" }]);
  });

  it("keeps only the notes of the latest attempt", async () => {
    await createTask("Refunds");
    await finish(await claim(), [cents, esm], false);
    await store.sweep();
    await finish(await claim(), [esm]);

    const entries = await knowledge();
    expect(entries.filter((k) => k.status === "proposed").map((k) => k.title)).toEqual([esm.title]);
    expect(entries.filter((k) => k.status === "archived")).toHaveLength(2);
  });

  it("supersedes an accepted fact that is restated", async () => {
    const old = (await call<KnowledgeDto>("POST", `/projects/${project.id}/knowledge`, { ...cents, body: "Amounts are cents." })).body;
    expect(old).toMatchObject({ status: "accepted", createdBy: "local", sourceTaskId: null });

    const task = await createTask("Refunds");
    await finish(await claim(), [{ ...cents, title: "amounts are integer CENTS" }]);
    await approveAndMerge(task.id);

    const accepted = await knowledge("accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.body).toBe(cents.body);
    expect((await call<KnowledgeDto>("GET", `/knowledge/${old.id}`)).body).toMatchObject({ status: "archived", supersededBy: accepted[0]!.id });
  });

  it("lets people accept, edit and archive entries", async () => {
    await createTask("Refunds");
    await finish(await claim(), [esm]);
    const [proposed] = await knowledge("proposed");

    const accepted = await call<KnowledgeDto>("PUT", `/knowledge/${proposed!.id}`, { status: "accepted", body: "ESM only (type: module)." });
    expect(accepted.body).toMatchObject({ status: "accepted", body: "ESM only (type: module).", decidedBy: "local" });
    const archived = await call<KnowledgeDto>("PUT", `/knowledge/${proposed!.id}`, { status: "archived" });
    expect(archived.body.status).toBe("archived");
    expect(await knowledge("accepted")).toEqual([]);

    expect((await call("POST", `/projects/${project.id}/knowledge`, { kind: "gossip", title: "x", body: "y" })).status).toBe(400);
  });

  it("accepts what the planner learned when its plan is approved", async () => {
    const plan = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    const c = await claim();
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: {
        kind: "completed",
        sessionId: "s-plan",
        success: true,
        deniedActions: [],
        result: { summary: "s", tasks: [{ ref: "T1", title: "Refunds", objective: "o", agent: null, requires: [], dependsOn: [] }], knowledge: [esm] },
      },
    });
    expect(await knowledge("proposed")).toHaveLength(1);
    await call("POST", `/plans/${plan.id}/approve`, {});
    expect(await knowledge("accepted")).toEqual([expect.objectContaining({ title: esm.title, sourceTaskKey: "PAY-1", decidedBy: "local" })]);
  });
});
