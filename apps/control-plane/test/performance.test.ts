import type { AgentDescriptor, AgentSkillStats, AgentStats, ClaimResponse, EventsPage, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Agent performance (spec §40) and selection by it. */

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
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("alpha"), agent("beta")] })).body.runnerId;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

function agent(id: string): AgentDescriptor {
  return {
    id,
    adapter: id,
    skills: ["backend", "frontend"],
    capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
  };
}

const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;

/** One run of a fixed task needing `skill`: delivered (passing or failing validation) or failed. */
async function run(agentId: string, skill: string, outcome: "pass" | "fail_validation" | "fail") {
  await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: agentId, requires: [skill], maxAttempts: 1 });
  const c = await claim();
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  if (outcome === "fail") {
    await call("POST", `/executions/${c.execution.id}/complete`, { exitCode: 1, terminal: { kind: "failed", sessionId: "s", reason: "broke" } });
    return;
  }
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result: { summary: "ok" } },
  });
  await call("POST", `/executions/${c.execution.id}/validation`, { passed: outcome === "pass", steps: [], changedFiles: [] });
  if (outcome === "pass") {
    await call("POST", `/executions/${c.execution.id}/delivery`, { branch: `task/${c.task.key}`, commitSha: null, changedFiles: [] });
  }
}

describe("agent performance", () => {
  it("measures validation pass, review rejection and task outcomes", async () => {
    await run("alpha", "backend", "pass");
    await run("alpha", "backend", "fail_validation");
    const tasks = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body;
    await call("POST", `/tasks/${tasks[0]!.id}/review`, { decision: "reject", comment: "no" });
    await store.sweep();

    const alpha = (await call<AgentStats[]>("GET", "/agents/stats")).body.find((s) => s.agent === "alpha")!;
    expect(alpha).toMatchObject({ executions: 2, validations: 2, validationsPassed: 1, reviews: 1, reviewRejections: 1, tasksBlocked: 2 });
  });

  it("routes a skill to the agent that does it well on this project", async () => {
    // alpha is fine at backend but keeps failing frontend; beta does frontend well.
    for (let i = 0; i < 3; i++) await run("alpha", "backend", "pass");
    for (let i = 0; i < 3; i++) await run("alpha", "frontend", "fail");
    for (let i = 0; i < 3; i++) await run("beta", "frontend", "pass");
    await run("beta", "backend", "fail");

    const skills = (await call<AgentSkillStats[]>("GET", `/agents/skill-stats?projectId=${project.id}`)).body;
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "alpha", skill: "frontend", succeeded: 0, failed: 3 }),
        expect.objectContaining({ agent: "beta", skill: "frontend", succeeded: 3, failed: 0 }),
      ]),
    );

    const frontend = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "ui", objective: "o", agent: "auto", requires: ["frontend"] })).body;
    expect((await claim()).task).toMatchObject({ id: frontend.id, agent: "beta" });
    const reason = (await call<EventsPage>("GET", `/tasks/${frontend.id}/events`)).body.events.find((e) => e.type === "AgentSelected")!.payload.reason;
    expect(reason).toContain("3/3 on frontend");

    const backend = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "api", objective: "o", agent: "auto", requires: ["backend"] })).body;
    expect((await claim()).task).toMatchObject({ id: backend.id, agent: "alpha" });
  });

  it("lets the owner change the routing policy", async () => {
    const res = await call<ProjectDto>("PUT", `/projects/${project.id}/routing-policy`, { routingPolicy: "speed" });
    expect(res.body.routingPolicy).toBe("speed");
    expect((await call("PUT", `/projects/${project.id}/routing-policy`, { routingPolicy: "vibes" })).status).toBe(400);
  });
});
