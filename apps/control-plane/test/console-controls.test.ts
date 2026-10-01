import type { AgentDescriptor, ArtifactDto, ClaimResponse, ExecutionDto, InstructionDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Agent console controls (spec §43): pause / resume, instructions, diff. */

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
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent] })).body.runnerId;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent: AgentDescriptor = {
  id: "claude",
  adapter: "claude",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
};

const create = async () => (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "claude" })).body;
const get = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;
const claim = () => call<ClaimResponse>("POST", `/runners/${runnerId}/claim`);

/** Claims the task and starts the agent with a session. */
async function running() {
  const c = (await claim()).body;
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
  await call("POST", `/executions/${c.execution.id}/events`, { events: [{ kind: "session_started", sessionId: "s-1" }] });
  return c;
}
/** What the runner does once the heartbeat says stop: kills the agent and reports it with the diff so far. */
async function stopped(c: ClaimResponse) {
  expect((await call<{ cancel: boolean }>("POST", `/executions/${c.execution.id}/heartbeat`)).body.cancel).toBe(true);
  return call<ExecutionDto>("POST", `/executions/${c.execution.id}/complete`, {
    exitCode: null,
    terminal: { kind: "failed", reason: "cancelled" },
    diff: "diff --git a/src/a.js b/src/a.js\n+x\n",
  });
}

describe("console controls", () => {
  it("pauses work that has not started and resumes it", async () => {
    const t = await create();
    expect((await call<TaskDto>("POST", `/tasks/${t.id}/pause`)).body.state).toBe("PAUSED");
    expect((await claim()).status).toBe(204);
    expect((await call<TaskDto>("POST", `/tasks/${t.id}/resume`)).body.state).toBe("READY");
    expect((await claim()).body.task.id).toBe(t.id);
    expect((await call("POST", `/tasks/${t.id}/resume`)).status).toBe(409);
  });

  it("pauses a running agent, keeps its diff, and resumes the same session without using an attempt", async () => {
    const t = await create();
    const c = await running();
    expect((await call<TaskDto>("POST", `/tasks/${t.id}/pause`)).body.state).toBe("RUNNING"); // until the runner stops it
    expect((await stopped(c)).body.status).toBe("interrupted");
    expect((await get(t.id)).state).toBe("PAUSED");

    const [diff] = (await call<ArtifactDto[]>("GET", `/tasks/${t.id}/artifacts`)).body.filter((a) => a.type === "diff");
    expect(diff!.content).toEqual({ text: "diff --git a/src/a.js b/src/a.js\n+x\n", files: ["src/a.js"] });

    await call("POST", `/tasks/${t.id}/resume`);
    const next = (await claim()).body;
    expect(next.resume).toMatchObject({ sessionId: "s-1" });
    expect(next.execution.attempt).toBe(2);
    // Interrupted runs are not failed attempts.
    const [row] = await db.query<{ attempts: number }>(
      "select count(*)::int as attempts from executions where task_id = $1 and status <> 'interrupted'",
      [t.id],
    );
    expect(row!.attempts).toBe(1);
  });

  it("stops a running agent for a new instruction and gives it on the resumed run", async () => {
    const t = await create();
    const c = await running();
    const sent = await call<InstructionDto>("POST", `/tasks/${t.id}/instructions`, { text: "Use cents, not floats." });
    expect(sent.status).toBe(201);
    await stopped(c);
    expect((await get(t.id)).state).toBe("READY");

    const next = (await claim()).body;
    expect(next.resume).toMatchObject({ sessionId: "s-1" });
    expect(next.instructions).toEqual([expect.objectContaining({ text: "Use cents, not floats.", author: "local", executionId: next.execution.id })]);
    // Given once.
    const list = (await call<InstructionDto[]>("GET", `/tasks/${t.id}/instructions`)).body;
    expect(list).toEqual([expect.objectContaining({ executionId: next.execution.id })]);
  });

  it("queues an instruction without interrupting when asked, or when the agent is not running", async () => {
    const t = await create();
    await call("POST", `/tasks/${t.id}/instructions`, { text: "Also update the README." });
    const c = await running();
    expect(c.instructions?.map((i) => i.text)).toEqual(["Also update the README."]);
    await call("POST", `/tasks/${t.id}/instructions`, { text: "later", interrupt: false });
    expect((await call<{ cancel: boolean }>("POST", `/executions/${c.execution.id}/heartbeat`)).body.cancel).toBe(false);
  });

  it("refuses controls that do not apply", async () => {
    const t = await create();
    await call("POST", `/tasks/${t.id}/cancel`);
    expect((await call("POST", `/tasks/${t.id}/pause`)).status).toBe(409);
    expect((await call("POST", `/tasks/${t.id}/instructions`, { text: "x" })).status).toBe(409);
  });
});
