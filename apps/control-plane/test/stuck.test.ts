import type { AgentDescriptor, ApprovalDto, ClaimResponse, DecisionDto, ProjectDto, StuckTaskDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Work waiting for a person always has something in the Inbox to act on. */

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
  await db.query("truncate events, approvals, decisions, artifacts, executions, tasks, runners, projects restart identity cascade");
  app = buildApp(new Store(db));
  project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent("cmd")] })).body.runnerId;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

function agent(id: string): AgentDescriptor {
  return {
    id,
    adapter: "command-code",
    skills: [],
    capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
  };
}

const result = (openQuestions: object[] = []) => ({
  summary: "stopped",
  changes: [],
  decisions: [],
  knownIssues: [],
  remainingWork: [],
  knowledge: [],
  openQuestions,
  criteria: [],
});

async function newTask(): Promise<{ task: TaskDto; claim: ClaimResponse }> {
  const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refunds", objective: "o", agent: "cmd" })).body;
  const claim = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${claim.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
  return { task, claim };
}

const complete = (c: ClaimResponse, deniedActions: string[], openQuestions: object[] = []) =>
  call("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s1", success: deniedActions.length === 0, deniedActions, result: result(openQuestions) },
  });

const state = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body.state;

describe("stuck tasks", () => {
  it("lists a task stopped by refused calls with nothing to approve, with the reasons", async () => {
    const { task, claim } = await newTask();
    // One call the policy refused outright, one the agent CLI refused itself.
    const check = await call<{ decision: string }>(
      "POST",
      `/executions/${claim.execution.id}/tool-check`,
      { tool: "shell_command", input: { command: "git push origin main" } },
      { "x-mar-execution-token": claim.executionToken },
    );
    expect(check.body.decision).toBe("deny");
    await call("POST", `/executions/${claim.execution.id}/events`, {
      events: [{ kind: "permission_denied", tool: "write_file", detail: "Security hook failed (failClosed)" }],
    });
    await complete(claim, ["shell_command", "write_file"]);
    expect(await state(task.id)).toBe("WAITING_FOR_HUMAN");
    expect((await call<ApprovalDto[]>("GET", "/approvals?status=pending")).body).toEqual([]);

    const stuck = (await call<StuckTaskDto[]>("GET", "/stuck-tasks")).body;
    expect(stuck.map((s) => s.task.key)).toEqual(["PAY-1"]);
    expect(stuck[0]!.reasons).toEqual([expect.stringMatching(/^shell_command: \[CRITICAL\] /), "write_file: Security hook failed (failClosed)"]);

    // Retrying takes it out of the list.
    await call("POST", `/tasks/${task.id}/retry`);
    expect((await call<StuckTaskDto[]>("GET", "/stuck-tasks")).body).toEqual([]);
  });

  it("does not list tasks that have a question or an approval waiting", async () => {
    const { claim } = await newTask();
    await complete(claim, [], [{ question: "Which currency?", options: ["EUR"], context: "" }]);
    expect((await call<StuckTaskDto[]>("GET", "/stuck-tasks")).body).toEqual([]);
  });
});

describe("withdrawing what nobody answered", () => {
  it("withdraws a task's open questions when it is cancelled or retried", async () => {
    const first = await newTask();
    await complete(first.claim, [], [{ question: "Which currency?", options: [], context: "" }]);
    await call("POST", `/tasks/${first.task.id}/cancel`);
    expect((await call<DecisionDto[]>("GET", "/decisions?status=pending")).body).toEqual([]);
    expect((await call<DecisionDto[]>("GET", "/decisions?status=withdrawn")).body.map((d) => d.question)).toEqual(["Which currency?"]);

    const second = await newTask();
    await complete(second.claim, [], [{ question: "Round up?", options: [], context: "" }]);
    await call("POST", `/tasks/${second.task.id}/retry`);
    expect((await call<DecisionDto[]>("GET", "/decisions?status=pending")).body).toEqual([]);
    expect(await state(second.task.id)).toBe("READY");
  });
});
