import type { AgentDescriptor, ClaimResponse, EventDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Failures that are the machine's (or a loop's), not the agent's: no rework, no pointless agent changes. */

let db: Db;
let app: FastifyInstance;
let store: Store;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, decisions, executions, tasks, runners, projects restart identity cascade");
  store = new Store(db);
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
let project: ProjectDto;
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
const task = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;
const events = async (id: string) => (await call<{ events: EventDto[] }>("GET", `/tasks/${id}/events`)).body.events;

async function setup() {
  project = (await call<ProjectDto>("POST", "/projects", { key: "TBP", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r", agents: [agent("codex"), agent("claude")] })).body.runnerId;
  return (
    await call<TaskDto>("POST", `/projects/${project.id}/tasks`, {
      title: "A",
      objective: "o",
      agent: "codex",
      maxAttempts: 4,
      fallbackAgents: ["claude"],
      routing: "fixed",
    })
  ).body;
}

const handoff = (extra: object = {}) => ({
  summary: "done",
  changes: [],
  decisions: [],
  knownIssues: [],
  remainingWork: [],
  knowledge: [],
  ...extra,
});

async function runUntilValidated(c: ClaimResponse, steps: object[]) {
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result: handoff() },
  });
  await call("POST", `/executions/${c.execution.id}/validation`, { passed: false, steps, changedFiles: [] });
}

const failedStep = (outputTail: string, extra: object = {}) => ({
  name: "test",
  command: "pnpm test",
  passed: false,
  exitCode: 1,
  durationMs: 5,
  outputTail,
  ...extra,
});

describe("validation that could not run", () => {
  it("is a failed attempt, not a rework, and does not move the task to another agent", async () => {
    const t = await setup();
    await runUntilValidated(await claim(), [failedStep("'jest' is not recognized as an internal or external command")]);
    await store.sweep();
    await runUntilValidated(await claim(), [failedStep("anything", { environment: true })]);
    await store.sweep();

    const after = await task(t.id);
    expect(after.agent).toBe("codex");
    expect(after.state).toBe("READY");
    const all = await events(t.id);
    expect(all.filter((e) => e.type === "ValidationFailed").map((e) => e.payload.environment)).toEqual([true, true]);
    expect(all.some((e) => e.type === "TaskReassigned")).toBe(false);
  });

  it("does not tell the next attempt to fix the machine", async () => {
    const t = await setup();
    await runUntilValidated(await claim(), [failedStep("node_modules missing")]);
    await store.sweep();
    const next = await claim();
    expect(next.task.id).toBe(t.id);
    expect(next.rework ?? null).toBeNull();
  });
});

describe("the same validation failure twice", () => {
  it("hands the task to the fallback agent instead of another rework", async () => {
    const t = await setup();
    await runUntilValidated(await claim(), [failedStep("FAIL a.spec.ts\nError: expected 1 but got 2")]);
    // A first failure is an ordinary rework for the same agent.
    expect((await task(t.id)).state).toBe("REWORK");
    await store.sweep();
    await runUntilValidated(await claim(), [failedStep("FAIL a.spec.ts\nError: expected 5 but got 6")]);
    await store.sweep();

    expect((await task(t.id)).agent).toBe("claude");
    expect((await events(t.id)).find((e) => e.type === "TaskReassigned")).toMatchObject({ payload: { from: "codex", to: "claude" } });
  });
});

describe("a question that was already answered", () => {
  it("fails the attempt and moves the task on instead of asking the person again", async () => {
    const t = await setup();
    const ask = async (question: string) => {
      const c = await claim();
      await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/TBP-1" });
      await call("POST", `/executions/${c.execution.id}/complete`, {
        exitCode: 0,
        terminal: {
          kind: "completed",
          sessionId: "s",
          success: true,
          deniedActions: [],
          result: handoff({ openQuestions: [{ question, options: [], context: "" }] }),
        },
      });
    };
    await ask("Bạn có thể cung cấp môi trường đã cài dependencies hoặc cho phép kết nối package registry để chạy lại validation không?");
    const [decision] = (await call<Array<{ id: string }>>("GET", "/decisions?status=pending")).body;
    await call("POST", `/decisions/${decision!.id}/answer`, { answer: "Cung cấp môi trường có node_modules" });
    await store.sweep();

    await ask("Bạn có thể cung cấp worktree đã cài dependencies hoặc môi trường cho phép truy cập npm registry để chạy validation không?");
    expect((await call<unknown[]>("GET", "/decisions?status=pending")).body).toHaveLength(0);
    await store.sweep();

    expect((await task(t.id)).agent).toBe("claude");
    const finished = (await events(t.id)).filter((e) => e.type === "AgentFinished");
    expect(finished.at(-1)?.payload).toMatchObject({ status: "failed", reason: "asked a question that was already answered" });
  });
});
