import type { AgentDescriptor, ClaimResponse, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Work goes to agents some online runner actually offers. */

let db: Db;
let app: FastifyInstance;
let project: ProjectDto;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, decisions, artifacts, executions, tasks, runners, projects restart identity cascade");
  app = buildApp(new Store(db));
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
});
afterEach(() => app.close());

async function call<T = unknown>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string): AgentDescriptor => ({
  id,
  adapter: id,
  skills: [],
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
});
const register = async (name: string, ids: string[]) =>
  (await call<{ runnerId: string }>("POST", "/runners/register", { name, agents: ids.map(agent) })).body.runnerId;
const claim = async (runnerId: string) => (await call<ClaimResponse | null>("POST", `/runners/${runnerId}/claim`)).body;

describe("reviewer choice", () => {
  it("picks the first configured reviewer that an online runner offers", async () => {
    // agy is configured first, but no runner offers it.
    await call("PUT", `/projects/${project.id}/review`, { reviewAgents: ["claude", "agy", "codex"] });
    const runner = await register("box", ["claude", "codex"]);
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "T", objective: "o", agent: "claude" })).body;
    const c = (await claim(runner))!;
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: {
        kind: "completed",
        sessionId: "s",
        success: true,
        deniedActions: [],
        result: { summary: "done", changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: [], openQuestions: [], criteria: [] },
      },
    });
    await call("POST", `/executions/${c.execution.id}/validation`, { passed: true, steps: [], changedFiles: [] });
    await call("POST", `/executions/${c.execution.id}/delivery`, { branch: "task/PAY-1", commitSha: "abc1234", changedFiles: ["a.ts"] });

    const review = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.find((t) => t.reviewOf === task.id)!;
    expect(review).toMatchObject({ agent: "codex", fallbackAgents: ["agy"], excludedAgents: ["claude"] });
    expect((await claim(runner))!.task.id).toBe(review.id);
  });
});

describe("fallback agents", () => {
  it("give a task whose agent no online runner offers to a fallback", async () => {
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "T", objective: "o", agent: "agy", fallbackAgents: ["codex"] }))
      .body;
    const runner = await register("box", ["codex"]);
    const c = (await claim(runner))!;
    expect(c.task).toMatchObject({ id: task.id, agent: "codex" });
    const events = (await call<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>("GET", `/tasks/${task.id}/events`)).body.events;
    expect(events.find((e) => e.type === "AgentSelected")?.payload).toMatchObject({ agent: "codex", reason: "no online runner offers agy; fallback codex" });
  });

  it("leave the task to its own agent while a runner offers it", async () => {
    await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "T", objective: "o", agent: "agy", fallbackAgents: ["codex"] });
    const codexBox = await register("codex-box", ["codex"]);
    await register("agy-box", ["agy"]);
    expect(await claim(codexBox)).toBeFalsy();
  });
});
