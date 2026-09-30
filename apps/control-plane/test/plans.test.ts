import type { AgentDescriptor, ClaimResponse, EventsPage, PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Assisted planning (spec §24): a planner agent proposes a DAG, a human decides. */

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

const agent = (id: string, skills: string[]): AgentDescriptor => ({
  id,
  adapter: id,
  skills,
  cost: "medium",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});

async function setup() {
  const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  const runnerId = (
    await call<{ runnerId: string }>("POST", "/runners/register", {
      name: "box",
      agents: [agent("claude", ["backend", "planning"]), agent("agy", ["frontend"])],
    })
  ).body.runnerId;
  return { project, runnerId };
}

const claim = async (runnerId: string) => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const plan = async (id: string) => (await call<PlanDto>("GET", `/plans/${id}`)).body;
const tasksOf = async (projectId: string) => (await call<TaskDto[]>("GET", `/projects/${projectId}/tasks`)).body;

const proposal = {
  summary: "API first, then UI and docs in parallel.",
  tasks: [
    { ref: "T2", title: "Refund UI", objective: "Add a refund button", agent: null, requires: ["frontend"], dependsOn: ["T1"] },
    { ref: "T1", title: "Refund API", objective: "Add POST /refunds", agent: "claude", requires: [], dependsOn: [] },
    { ref: "T3", title: "Docs", objective: "Document refunds", agent: "ghost-agent", requires: [], dependsOn: ["T1"] },
  ],
};

/** The planner answers with the given result. */
async function propose(runnerId: string, result: unknown) {
  const c = await claim(runnerId);
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s-plan", success: true, deniedActions: [], result },
  });
  return c;
}

describe("plans", () => {
  it("runs a planner task with the goal, the agents and the open work", async () => {
    const { project, runnerId } = await setup();
    await call("POST", `/projects/${project.id}/tasks`, { title: "Existing", objective: "x", agent: "agy" });
    const created = await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "planning", goal: "Add refunds", plannerTaskKey: "PAY-2", plannerAgent: "claude" });

    await claim(runnerId); // the existing work task
    const c = await claim(runnerId);
    expect(c.task).toMatchObject({ kind: "plan", title: "Plan: Add refunds", planId: created.body.id });
    expect(c.plan).toMatchObject({
      goal: "Add refunds",
      baseBranch: "main",
      agents: [
        { id: "claude", skills: ["backend", "planning"], cost: "medium" },
        { id: "agy", skills: ["frontend"], cost: "medium" },
      ],
      openTasks: [{ key: "PAY-1", title: "Existing", state: "ASSIGNED" }],
    });
  });

  it("records the proposal and creates the DAG on approval", async () => {
    const { project, runnerId } = await setup();
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    const c = await propose(runnerId, proposal);

    expect((await call<TaskDto>("GET", `/tasks/${c.task.id}`)).body.state).toBe("COMPLETED");
    const proposed = await plan(id);
    expect(proposed.status).toBe("proposed");
    // Dependency order; an agent that does not exist is left to the scheduler.
    expect(proposed.proposal?.tasks.map((t) => [t.ref, t.agent])).toEqual([
      ["T1", "claude"],
      ["T2", null],
      ["T3", null],
    ]);
    expect((await tasksOf(project.id)).filter((t) => t.kind === "work")).toEqual([]);

    const approved = await call<PlanDto>("POST", `/plans/${id}/approve`, {});
    expect(approved.body).toMatchObject({ status: "approved", decidedBy: "local" });
    expect(approved.body.createdTasks.map((t) => [t.ref, t.key])).toEqual([
      ["T1", "PAY-2"],
      ["T2", "PAY-3"],
      ["T3", "PAY-4"],
    ]);
    const tasks = await tasksOf(project.id);
    const byKey = (k: string) => tasks.find((t) => t.key === k)!;
    expect(byKey("PAY-2")).toMatchObject({ agent: "claude", state: "READY", planId: id, dependsOn: [] });
    expect(byKey("PAY-3")).toMatchObject({ agent: "auto", requires: ["frontend"], state: "CREATED", dependsOn: [byKey("PAY-2").id] });
    expect(byKey("PAY-4")).toMatchObject({ agent: "auto", state: "CREATED", dependsOn: [byKey("PAY-2").id] });

    const events = (await call<EventsPage>("GET", `/projects/${project.id}/events`)).body.events.map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["PlanRequested", "PlanProposed", "PlanApproved"]));
    expect((await call("POST", `/plans/${id}/approve`, {})).status).toBe(409);
  });

  it("creates the tasks as edited by the reviewer", async () => {
    const { project, runnerId } = await setup();
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    await propose(runnerId, proposal);

    const cyclic = [
      { ref: "A", title: "a", objective: "a", agent: null, dependsOn: ["B"] },
      { ref: "B", title: "b", objective: "b", agent: null, dependsOn: ["A"] },
    ];
    expect((await call("POST", `/plans/${id}/approve`, { tasks: cyclic })).status).toBe(409);

    const edited = [{ ref: "T1", title: "Refund API only", objective: "Add POST /refunds", agent: "agy", dependsOn: [] }];
    const approved = (await call<PlanDto>("POST", `/plans/${id}/approve`, { tasks: edited, comment: "UI later" })).body;
    expect(approved).toMatchObject({ status: "approved", comment: "UI later", proposal: { tasks: [{ title: "Refund API only" }] } });
    expect((await tasksOf(project.id)).filter((t) => t.kind === "work").map((t) => [t.title, t.agent])).toEqual([["Refund API only", "agy"]]);
  });

  it("sends a proposal back to the planner with feedback", async () => {
    const { project, runnerId } = await setup();
    const first = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    await propose(runnerId, proposal);

    const revised = await call<PlanDto>("POST", `/plans/${first.id}/revise`, { feedback: "Split the API into model and endpoint." });
    expect(revised.status).toBe(201);
    expect(revised.body).toMatchObject({ status: "planning", previousPlanId: first.id, feedback: "Split the API into model and endpoint." });
    expect((await plan(first.id)).status).toBe("revised");

    const c = await claim(runnerId);
    expect(c.plan).toMatchObject({
      planId: revised.body.id,
      previous: { feedback: "Split the API into model and endpoint.", proposal: { summary: proposal.summary } },
    });
  });

  it("accepts a planner finding nothing to do, but not an empty approval", async () => {
    const { project, runnerId } = await setup();
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    await propose(runnerId, { summary: "Refunds are already implemented.", tasks: [] });
    expect(await plan(id)).toMatchObject({ status: "proposed", proposal: { summary: "Refunds are already implemented.", tasks: [] } });
    expect((await call("POST", `/plans/${id}/approve`, {})).status).toBe(409);
    expect((await call<PlanDto>("POST", `/plans/${id}/reject`, {})).body.status).toBe("rejected");
  });

  it("retries a planner that returns no usable plan, then marks the plan failed", async () => {
    const { project, runnerId } = await setup();
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    await propose(runnerId, { summary: "no list" });
    await store.sweep();
    expect((await plan(id)).status).toBe("planning");
    await propose(runnerId, "I could not plan this");
    await store.sweep();
    expect((await plan(id)).status).toBe("failed");
  });

  it("rejects a plan and stops its planner", async () => {
    const { project } = await setup();
    const created = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds", agent: "claude" })).body;
    const rejected = (await call<PlanDto>("POST", `/plans/${created.id}/reject`, { comment: "not now" })).body;
    expect(rejected).toMatchObject({ status: "rejected", comment: "not now" });
    expect((await call<TaskDto>("GET", `/tasks/${created.plannerTaskId}`)).body.state).toBe("CANCELLED");
    expect((await call<PlanDto[]>("GET", `/projects/${project.id}/plans`)).body.map((p) => p.status)).toEqual(["rejected"]);
  });
});
