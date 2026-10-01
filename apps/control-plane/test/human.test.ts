import type { AgentDescriptor, ClaimResponse, DecisionDto, PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Human as executor (spec §61). */

let db: Db;
let app: FastifyInstance;
let project: ProjectDto;
let runnerId: string;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects restart identity cascade");
  app = buildApp(new Store(db));
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("claude")] })).body.runnerId;
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
    skills: ["backend"],
    capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
  };
}

const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body.state;

async function finish(c: ClaimResponse, openQuestions: object[]) {
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: {
      kind: "completed",
      sessionId: "s1",
      success: true,
      deniedActions: [],
      result: { summary: "half done", changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: [], openQuestions },
    },
  });
}

describe("decision requests", () => {
  it("waits for a person to answer the agent's questions, then resumes it with the answers", async () => {
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refunds", objective: "o", agent: "claude" })).body;
    await finish(await claim(), [
      { question: "Can a partial refund exceed 30 days?", options: ["yes", "no"], context: "No rule in the code." },
      { question: "Who approves refunds over 500 EUR?", options: [], context: "" },
    ]);
    expect(await state(task.id)).toBe("WAITING_FOR_HUMAN");
    const pending = (await call<DecisionDto[]>("GET", "/decisions?status=pending")).body;
    expect(pending.map((d) => [d.taskKey, d.agent, d.question, d.options])).toEqual([
      ["PAY-1", "claude", "Can a partial refund exceed 30 days?", ["yes", "no"]],
      ["PAY-1", "claude", "Who approves refunds over 500 EUR?", []],
    ]);

    await call("POST", `/decisions/${pending[0]!.id}/answer`, { answer: "no" });
    expect(await state(task.id)).toBe("WAITING_FOR_HUMAN");
    const answered = await call<DecisionDto>("POST", `/decisions/${pending[1]!.id}/answer`, { answer: "A senior on the support team" });
    expect(answered.body).toMatchObject({ status: "answered", answeredBy: "local" });
    expect(await state(task.id)).toBe("READY");
    expect((await call("POST", `/decisions/${pending[1]!.id}/answer`, { answer: "again" })).status).toBe(409);

    const again = await claim();
    expect(again.resume?.sessionId).toBe("s1");
    expect(again.decisions).toEqual([
      { question: "Can a partial refund exceed 30 days?", answer: "no", answeredBy: "local" },
      { question: "Who approves refunds over 500 EUR?", answer: "A senior on the support team", answeredBy: "local" },
    ]);
  });

  it("ignores open questions from review tasks and handles a run without them normally", async () => {
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "claude" })).body;
    await finish(await claim(), []);
    expect(await state(task.id)).toBe("VALIDATING");
  });
});

describe("tasks for a person", () => {
  it("are never claimed by runners; a person does them and the next task learns the outcome", async () => {
    const decide = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Pick the refund window", objective: "Decide how long refunds are allowed", agent: "human" })).body;
    const build = (
      await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Enforce the window", objective: "o", agent: "claude", dependsOn: [decide.id] })
    ).body;
    expect(await claim()).toBeFalsy();
    expect((await call<TaskDto[]>("GET", "/human-tasks")).body.map((t) => t.key)).toEqual(["PAY-1"]);

    expect((await call("POST", `/tasks/${build.id}/done`, { summary: "x" })).status).toBe(409);
    const done = await call<TaskDto>("POST", `/tasks/${decide.id}/done`, { summary: "30 days, then only with a senior's approval." });
    expect(done.body.state).toBe("COMPLETED");
    expect(await state(build.id)).toBe("READY");

    const c = await claim();
    expect(c.task.id).toBe(build.id);
    expect(c.dependencies).toEqual([
      { key: "PAY-1", title: "Pick the refund window", handoff: expect.objectContaining({ summary: "30 days, then only with a senior's approval." }) },
    ]);
  });

  it("reserves the human executor", async () => {
    const res = await call("POST", "/runners/register", { name: "x", agents: [agent("human")] });
    expect(res.status).toBe(400);
  });

  it("offers planners a person for decisions, and plans with human tasks can approve themselves", async () => {
    await call("PUT", `/projects/${project.id}/planning`, { critics: [], maxRounds: 0, autoApprove: false, maxAutoTasks: 5 });
    const plan = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Refund window", agent: "claude" })).body;
    const c = await claim();
    expect(c.plan?.agents.map((a) => a.id)).toEqual(["claude", "human"]);
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: {
        kind: "completed",
        sessionId: "s",
        success: true,
        deniedActions: [],
        result: {
          summary: "decide, then build",
          tasks: [
            { ref: "T1", title: "Decide the window", objective: "Pick it", agent: "human", requires: [], dependsOn: [] },
            { ref: "T2", title: "Build it", objective: "Enforce it", agent: "claude", requires: [], dependsOn: ["T1"] },
          ],
          knowledge: [],
        },
      },
    });
    const proposed = (await call<PlanDto>("GET", `/plans/${plan.id}`)).body;
    expect(proposed.proposal?.tasks.map((t) => t.agent)).toEqual(["human", "claude"]);
  });
});
