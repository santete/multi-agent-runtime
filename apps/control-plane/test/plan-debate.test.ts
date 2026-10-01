import type { AgentDescriptor, ClaimResponse, EventsPage, PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Multi-agent debate on plans and autonomous approval (spec §53). */

let db: Db;
let app: FastifyInstance;
let store: Store;
let project: ProjectDto;
let runnerId: string;

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
  skills: ["backend"],
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});

async function setup(planning: object) {
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git", planning })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("claude"), agent("codex")] })).body.runnerId;
}

const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const plan = async (id: string) => (await call<PlanDto>("GET", `/plans/${id}`)).body;
const plans = async () => (await call<PlanDto[]>("GET", `/projects/${project.id}/plans`)).body;

const task = (ref: string, dependsOn: string[] = []) => ({ ref, title: `Task ${ref}`, objective: `Do ${ref}`, agent: null, requires: ["backend"], dependsOn });

async function answer(c: ClaimResponse, result: unknown) {
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: `s-${c.task.key}`, success: true, deniedActions: [], result },
  });
}

const propose = async (tasks = [task("T1"), task("T2", ["T1"])]) => {
  const c = await claim();
  expect(c.task.kind).toBe("plan");
  await answer(c, { summary: "two steps", tasks, knowledge: [] });
  return c;
};
const critique = async (verdict: "approve" | "revise", issues: object[] = []) => {
  const c = await claim();
  expect(c.task.kind).toBe("critique");
  await answer(c, { verdict, summary: verdict === "approve" ? "Sound plan." : "Needs work.", issues });
  return c;
};

describe("plan debate", () => {
  it("has another agent critique the proposal before anyone decides", async () => {
    await setup({ critics: ["claude", "codex"] });
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    expect((await plan(id)).status).toBe("reviewing");

    const c = await claim();
    expect(c.task).toMatchObject({ kind: "critique", agent: "codex", planId: id });
    expect(c.critique).toMatchObject({ planId: id, goal: "Refunds", round: 1, planner: "claude", proposal: { tasks: [{ ref: "T1" }, { ref: "T2" }] } });
    await answer(c, { verdict: "approve", summary: "Sound plan.", issues: [{ ref: "T2", severity: "minor", message: "name the endpoint" }] });

    expect(await plan(id)).toMatchObject({
      status: "proposed",
      critique: { verdict: "approve", critic: "codex", issues: [{ ref: "T2", severity: "minor" }] },
    });
  });

  it("sends a revise verdict back to the planner, round after round, then to a person", async () => {
    await setup({ critics: ["codex"], maxRounds: 2, autoApprove: true });
    const first = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    await critique("revise", [{ ref: "T1", severity: "blocker", message: "split the migration out" }]);

    expect((await plan(first.id)).status).toBe("revised");
    const second = (await plans()).find((p) => p.previousPlanId === first.id)!;
    expect(second).toMatchObject({ status: "planning", round: 2, createdBy: "agent codex" });
    expect(second.feedback).toContain("[blocker] T1: split the migration out");

    const planner = await claim();
    expect(planner.plan?.previous?.feedback).toContain("split the migration out");
    await answer(planner, { summary: "three steps", tasks: [task("T0"), task("T1", ["T0"]), task("T2", ["T1"])], knowledge: [] });
    await critique("revise", [{ ref: null, severity: "major", message: "still too coarse" }]);

    // Rounds used up: a person decides, nothing is approved automatically.
    expect(await plan(second.id)).toMatchObject({ status: "proposed", round: 2, critique: { verdict: "revise" } });
    const events = (await call<EventsPage>("GET", `/projects/${project.id}/events?limit=1000`)).body.events;
    expect(events.find((e) => e.type === "PlanAutoApprovalSkipped")?.payload.reason).toBe("the critic still asks for changes after 2 round(s)");
  });

  it("approves itself within the project's autonomy and starts the work", async () => {
    await setup({ critics: ["codex"], autoApprove: true, maxAutoTasks: 3 });
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    await critique("approve");

    const approved = await plan(id);
    expect(approved).toMatchObject({ status: "approved", decidedBy: "platform" });
    expect(approved.createdTasks.map((t) => t.ref)).toEqual(["T1", "T2"]);
    const work = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.filter((t) => t.kind === "work");
    expect(work.map((t) => t.state)).toEqual(["READY", "CREATED"]);
  });

  it("leaves big or uncoverable plans to a person", async () => {
    await setup({ critics: ["codex"], autoApprove: true, maxAutoTasks: 1 });
    const big = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    await critique("approve");
    expect((await plan(big.id)).status).toBe("proposed");

    await call("PUT", `/projects/${project.id}/planning`, { critics: ["codex"], maxRounds: 2, autoApprove: true, maxAutoTasks: 5 });
    const rusty = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Rewrite in Rust", agent: "claude" })).body;
    await propose([{ ...task("T1"), requires: ["rust"] }]);
    await critique("approve");
    expect((await plan(rusty.id)).status).toBe("proposed");
    const reasons = (await call<EventsPage>("GET", `/projects/${project.id}/events?limit=1000`)).body.events
      .filter((e) => e.type === "PlanAutoApprovalSkipped")
      .map((e) => e.payload.reason);
    expect(reasons).toEqual(["2 tasks exceed the limit of 1 for automatic approval", "no online agent can take T1"]);
  });

  it("falls back to a person when the critic gives up, and lets a person reject meanwhile", async () => {
    await setup({ critics: ["codex"] });
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    for (let i = 0; i < 2; i++) {
      await answer(await claim(), "no idea");
      await store.sweep();
    }
    expect((await plan(id)).status).toBe("proposed");

    const other = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Voids", agent: "claude" })).body;
    await propose();
    expect((await plan(other.id)).status).toBe("reviewing");
    expect((await call<PlanDto>("POST", `/plans/${other.id}/reject`, { comment: "not now" })).body.status).toBe("rejected");
    const critiques = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.filter((t) => t.kind === "critique" && t.planId === other.id);
    expect(critiques.map((t) => t.state)).toEqual(["CANCELLED"]);
  });

  it("does not debate without critics", async () => {
    await setup({});
    const { id } = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refunds", agent: "claude" })).body;
    await propose();
    expect(await plan(id)).toMatchObject({ status: "proposed", critique: null, round: 1 });
  });
});
