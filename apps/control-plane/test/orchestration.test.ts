import type {
  AgentDescriptor,
  ApprovalDto,
  ClaimResponse,
  EventsPage,
  ExecutionDto,
  ProjectDto,
  TaskDto,
  TaskGraph,
} from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, type GitProvider, type MergeResult, migrate, Store } from "../src/index.js";

/** M4: task DAG, review, merge queue, approval gateway, parallelism limit. */

let db: Db;
let app: FastifyInstance;
let store: Store;

let mergeResults: MergeResult[] = [];
let mergeError: Error | undefined;
const merged: number[] = [];
let prCounter = 0;
const provider: GitProvider = {
  async openPullRequest() {
    prCounter++;
    return { url: `https://github.com/o/r/pull/${prCounter}`, number: prCounter };
  },
  async mergePullRequest(req) {
    if (mergeError) throw mergeError;
    const result = mergeResults.shift() ?? { status: "merged", sha: "abc" };
    if (result.status === "merged") merged.push(req.number);
    return result;
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
  mergeResults = [];
  mergeError = undefined;
  merged.length = 0;
  prCounter = 0;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const descriptor: AgentDescriptor = {
  id: "dev",
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: true },
};

async function project(extra: object = {}) {
  return (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "Payment", repoUrl: "https://github.com/o/r.git", ...extra })).body;
}
async function task(projectId: string, title: string, dependsOn?: string[]) {
  const res = await call<TaskDto>("POST", `/projects/${projectId}/tasks`, {
    title,
    objective: `do ${title}`,
    agent: "dev",
    ...(dependsOn && { dependsOn }),
  });
  expect(res.status).toBe(201);
  return res.body;
}
async function runner() {
  return (await call<{ runnerId: string }>("POST", "/runners/register", { name: "r1", agents: [descriptor] })).body.runnerId;
}
const get = async (id: string) => (await call<TaskDto>("GET", `/tasks/${id}`)).body;
const claim = async (runnerId: string) => call<ClaimResponse>("POST", `/runners/${runnerId}/claim`);

/** Runs the claimed task through agent, validation and delivery to REVIEW. */
async function deliver(c: ClaimResponse, summary = `did ${c.task.title}`) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "C:\\ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: {
      kind: "completed",
      sessionId: `s-${c.task.key}`,
      success: true,
      deniedActions: [],
      result: { summary, changes: [], decisions: [`decision of ${c.task.key}`], knownIssues: [], remainingWork: [] },
    },
  });
  await call("POST", `/executions/${id}/validation`, { passed: true, steps: [], changedFiles: ["a"] });
  await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: ["a"] });
}

async function approveAndMerge(taskId: string) {
  expect((await call<TaskDto>("POST", `/tasks/${taskId}/review`, { decision: "approve" })).body.state).toBe("APPROVED");
  await store.processMergeQueue();
}

describe("task dependencies (DAG)", () => {
  it("keeps dependent tasks waiting until their dependencies are merged, then unlocks them", async () => {
    const p = await project();
    const t1 = await task(p.id, "architecture");
    const t2 = await task(p.id, "db", [t1.id]);
    const t3 = await task(p.id, "api", [t1.key]); // by key
    const t4 = await task(p.id, "implementation", [t2.id, t3.id]);
    expect([t1, t2, t3, t4].map((t) => t.state)).toEqual(["READY", "CREATED", "CREATED", "CREATED"]);
    expect(t4.dependsOn.sort()).toEqual([t2.id, t3.id].sort());

    const graph = (await call<TaskGraph>("GET", `/projects/${p.id}/graph`)).body;
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: t1.id, to: t2.id },
        { from: t1.id, to: t3.id },
        { from: t2.id, to: t4.id },
        { from: t3.id, to: t4.id },
      ]),
    );

    const r = await runner();
    const c1 = (await claim(r)).body;
    expect(c1.task.id).toBe(t1.id);
    expect((await claim(r)).status).toBe(204); // nothing else is ready
    await deliver(c1);
    await approveAndMerge(t1.id);
    expect((await get(t1.id)).state).toBe("COMPLETED");

    // Both branches of the DAG are ready at once (they can run in parallel).
    expect([(await get(t2.id)).state, (await get(t3.id)).state]).toEqual(["READY", "READY"]);
    const c2 = (await claim(r)).body;
    const c3 = (await claim(r)).body;
    expect(new Set([c2.task.id, c3.task.id])).toEqual(new Set([t2.id, t3.id]));
    expect(c2.dependencies).toEqual([
      { key: "PAY-1", title: "architecture", handoff: expect.objectContaining({ decisions: ["decision of PAY-1"] }) },
    ]);

    // t4 waits for both.
    await deliver(c2);
    await approveAndMerge(c2.task.id);
    expect((await get(t4.id)).state).toBe("CREATED");
    await deliver(c3);
    await approveAndMerge(c3.task.id);
    expect((await get(t4.id)).state).toBe("READY");
    const c4 = (await claim(r)).body;
    expect(c4.dependencies!.map((d) => d.key).sort()).toEqual(["PAY-2", "PAY-3"]);
  });

  it("rejects unknown dependencies and dependencies from other projects", async () => {
    const p = await project();
    const other = (await call<ProjectDto>("POST", "/projects", { key: "OTH", name: "o", repoUrl: "x" })).body;
    const foreign = await task(other.id, "foreign");
    const res = await call("POST", `/projects/${p.id}/tasks`, { title: "t", objective: "o", agent: "dev", dependsOn: ["PAY-99"] });
    expect(res.status).toBe(409);
    const res2 = await call("POST", `/projects/${p.id}/tasks`, { title: "t", objective: "o", agent: "dev", dependsOn: [foreign.id] });
    expect(res2.status).toBe(409);
  });
});

describe("review and merge queue", () => {
  it("merges approved tasks one at a time per project", async () => {
    const p = await project();
    const a = await task(p.id, "a");
    const b = await task(p.id, "b");
    const r = await runner();
    const ca = (await claim(r)).body;
    const cb = (await claim(r)).body;
    await deliver(ca);
    await deliver(cb);
    await call("POST", `/tasks/${a.id}/review`, { decision: "approve" });
    await call("POST", `/tasks/${b.id}/review`, { decision: "approve" });

    expect(await store.processMergeQueue()).toEqual({ merged: 1, conflicts: 0, failed: 0 });
    expect(await store.processMergeQueue()).toEqual({ merged: 1, conflicts: 0, failed: 0 });
    expect(merged).toEqual([1, 2]);
    expect([(await get(a.id)).state, (await get(b.id)).state]).toEqual(["COMPLETED", "COMPLETED"]);
    const types = (await call<EventsPage>("GET", `/tasks/${a.id}/events?limit=1000`)).body.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["TaskMerged"]));
  });

  it("a rejected review goes back to rework with the reviewer's comment", async () => {
    const p = await project();
    const t = await task(p.id, "a");
    const r = await runner();
    await deliver((await claim(r)).body);
    const res = await call<TaskDto>("POST", `/tasks/${t.id}/review`, { decision: "reject", comment: "Amounts must be in cents" });
    expect(res.body.state).toBe("REWORK");
    await store.sweep();
    const again = (await claim(r)).body;
    expect(again.rework).toEqual({
      kind: "review",
      attempt: 1,
      reason: "the reviewer rejected the change",
      comment: "Amounts must be in cents",
    });
    expect(again.resume?.sessionId).toBe("s-PAY-1");
  });

  it("only reviews tasks in REVIEW", async () => {
    const p = await project();
    const t = await task(p.id, "a");
    expect((await call("POST", `/tasks/${t.id}/review`, { decision: "approve" })).status).toBe(409);
  });

  it("sends a conflicting merge back to rework with the base branch to merge in", async () => {
    const p = await project();
    const t = await task(p.id, "a");
    const r = await runner();
    await deliver((await claim(r)).body);
    mergeResults = [{ status: "conflict", message: "PR #1 has conflicts with main" }];
    await call("POST", `/tasks/${t.id}/review`, { decision: "approve" });
    expect(await store.processMergeQueue()).toEqual({ merged: 0, conflicts: 1, failed: 0 });
    expect((await get(t.id)).state).toBe("REWORK");
    await store.sweep();
    expect((await claim(r)).body.rework).toEqual({
      kind: "merge_conflict",
      attempt: 1,
      reason: "the branch conflicts with main",
      baseBranch: "main",
    });
  });

  it("waits while mergeability is pending and blocks after repeated failures", async () => {
    const p = await project();
    const t = await task(p.id, "a");
    const r = await runner();
    await deliver((await claim(r)).body);
    await call("POST", `/tasks/${t.id}/review`, { decision: "approve" });
    mergeResults = [{ status: "pending", message: "computing" }];
    await store.processMergeQueue();
    expect((await get(t.id)).state).toBe("MERGING");

    mergeError = new Error("GitHub 500");
    for (let i = 0; i < 3; i++) await store.processMergeQueue();
    expect((await get(t.id)).state).toBe("BLOCKED");
  });

  it("completes a reviewed task without a pull request (no changes) without calling the provider", async () => {
    const p = await project();
    const t = await task(p.id, "analysis");
    const r = await runner();
    const c = (await claim(r)).body;
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result: "report" },
    });
    await call("POST", `/executions/${c.execution.id}/validation`, { passed: true, steps: [], changedFiles: [] });
    await call("POST", `/executions/${c.execution.id}/delivery`, { branch: "task/PAY-1", commitSha: null, changedFiles: [] });
    await approveAndMerge(t.id);
    expect((await get(t.id)).state).toBe("COMPLETED");
    expect(merged).toEqual([]);
  });
});

describe("approval gateway", () => {
  async function running() {
    const p = await project();
    const t = await task(p.id, "fetch rates");
    const r = await runner();
    const c = (await claim(r)).body;
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
    return { t, r, c };
  }
  const check = (c: ClaimResponse, tool: string, command: string) =>
    app
      .inject({
        method: "POST",
        url: `/executions/${c.execution.id}/tool-check`,
        headers: { "x-mar-execution-token": c.executionToken },
        payload: { tool, input: { command } },
      })
      .then((res) => res.json());
  const finishDenied = (c: ClaimResponse) =>
    call<ExecutionDto>("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "s-1", success: false, deniedActions: ["Bash"], result: "blocked" },
    });

  it("turns a HIGH risk call into an approval request; once approved the task resumes and the call is allowed", async () => {
    const { t, r, c } = await running();
    const first = await check(c, "Bash", "curl https://rates.example.com/eur");
    expect(first).toMatchObject({ decision: "deny", risk: "HIGH", reason: expect.stringContaining("requires human approval") });
    await check(c, "Bash", "curl https://rates.example.com/eur"); // retried by the agent: no duplicate request

    const pending = (await call<ApprovalDto[]>("GET", "/approvals?status=pending")).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ taskId: t.id, tool: "Bash", risk: "HIGH", summary: "Bash: curl https://rates.example.com/eur" });

    await finishDenied(c);
    expect((await get(t.id)).state).toBe("WAITING_FOR_HUMAN");

    const decided = await call<ApprovalDto>("POST", `/approvals/${pending[0]!.id}/approve`, { comment: "read-only API, fine" });
    expect(decided.body).toMatchObject({ status: "approved", comment: "read-only API, fine" });
    expect((await get(t.id)).state).toBe("READY");

    const next = (await claim(r)).body;
    expect(next.approvals).toEqual([
      { tool: "Bash", summary: "Bash: curl https://rates.example.com/eur", status: "approved", comment: "read-only API, fine" },
    ]);
    expect(next.resume?.sessionId).toBe("s-1");
    await call("POST", `/executions/${next.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
    // Same command through another shell tool is still the approved action.
    expect(await check(next, "PowerShell", "curl https://rates.example.com/eur")).toMatchObject({
      decision: "allow",
      reason: expect.stringContaining("approved by a human"),
    });
    // A different command still needs its own approval.
    expect((await check(next, "Bash", "curl https://other.example.com")).decision).toBe("deny");
    expect((await call<ApprovalDto[]>("GET", `/tasks/${t.id}/approvals`)).body).toHaveLength(2);
  });

  it("requeues with the rejection when a human rejects", async () => {
    const { t, r, c } = await running();
    await check(c, "Bash", "curl https://x.example.com");
    await finishDenied(c);
    const [approval] = (await call<ApprovalDto[]>("GET", `/tasks/${t.id}/approvals`)).body;
    await call("POST", `/approvals/${approval!.id}/reject`, {});
    expect((await get(t.id)).state).toBe("READY");
    expect((await claim(r)).body.approvals).toEqual([
      { tool: "Bash", summary: "Bash: curl https://x.example.com", status: "rejected", comment: null },
    ]);
    expect((await call("POST", `/approvals/${approval!.id}/approve`, {})).status).toBe(409);
  });

  it("requeues right away when the approval was decided while the agent was still running", async () => {
    const { t, c } = await running();
    await check(c, "Bash", "curl https://x.example.com");
    const [approval] = (await call<ApprovalDto[]>("GET", "/approvals?status=pending")).body;
    await call("POST", `/approvals/${approval!.id}/approve`, {});
    expect((await get(t.id)).state).toBe("RUNNING");
    await finishDenied(c);
    expect((await get(t.id)).state).toBe("READY");
  });

  it("never offers approval for CRITICAL actions", async () => {
    const { t, c } = await running();
    expect(await check(c, "Bash", "git push origin main")).toMatchObject({ decision: "deny", risk: "CRITICAL" });
    expect((await call<ApprovalDto[]>("GET", `/tasks/${t.id}/approvals`)).body).toEqual([]);
    await finishDenied(c);
    expect((await get(t.id)).state).toBe("WAITING_FOR_HUMAN");
    // A human can still send it back to the queue explicitly.
    expect((await call<TaskDto>("POST", `/tasks/${t.id}/retry`)).body.state).toBe("READY");
    expect((await call("POST", `/tasks/${t.id}/retry`)).status).toBe(409);
  });
});

describe("post-hoc audit of sandboxed agents (approval: sandbox)", () => {
  const sandboxed: AgentDescriptor = {
    id: "codex",
    adapter: "codex",
    capabilities: { pause: "checkpoint", resume: true, approval: "sandbox", structuredOutput: true, streaming: true, costReporting: false },
  };

  async function codexRun() {
    const p = await project();
    const t = (await call<TaskDto>("POST", `/projects/${p.id}/tasks`, { title: "c", objective: "o", agent: "codex" })).body;
    const runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "cx", agents: [sandboxed] })).body
      .runnerId;
    const c = (await claim(runnerId)).body;
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws\\PAY-1", branch: "task/PAY-1" });
    return { t, c };
  }
  const toolCall = (callId: string, tool: string, input: object) => ({ kind: "tool_call", callId, tool, input });
  const complete = (c: ClaimResponse) =>
    call<ExecutionDto>("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "th-1", success: true, deniedActions: [], result: "done" },
    });
  const audits = async (taskId: string) =>
    (await call<EventsPage>("GET", `/tasks/${taskId}/events?limit=1000`)).body.events
      .filter((e) => e.type === "ToolCallChecked")
      .map((e) => [e.payload.decision, e.payload.audit]);

  it("audits every tool call and lets a clean run through", async () => {
    const { t, c } = await codexRun();
    await call("POST", `/executions/${c.execution.id}/events`, {
      events: [
        toolCall("i1", "shell", { command: "git status --short" }),
        toolCall("i2", "apply_patch", { paths: ["C:\\ws\\PAY-1\\src\\a.ts"] }),
      ],
    });
    expect(await audits(t.id)).toEqual([
      ["allow", true],
      ["allow", true],
    ]);
    expect((await complete(c)).body.status).toBe("validating");
  });

  it("flags a policy violation the sandbox did not stop, so a human reviews the run", async () => {
    const { t, c } = await codexRun();
    await call("POST", `/executions/${c.execution.id}/events`, {
      events: [toolCall("i1", "shell", { command: "cat .env" }), toolCall("i2", "apply_patch", { paths: ["C:\\elsewhere\\x.ts"] })],
    });
    expect(await audits(t.id)).toEqual([
      ["deny", true],
      ["deny", true],
    ]);
    expect((await complete(c)).body.status).toBe("needs_approval");
    expect((await get(t.id)).state).toBe("WAITING_FOR_HUMAN");
  });

  it("does not audit agents whose hook gates calls beforehand", async () => {
    const p = await project();
    const t = await task(p.id, "claude task");
    const r = await runner();
    const c = (await claim(r)).body;
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: "b" });
    await call("POST", `/executions/${c.execution.id}/events`, { events: [toolCall("i1", "Bash", { command: "cat .env" })] });
    expect(await audits(t.id)).toEqual([]);
  });
});

describe("project parallelism limit", () => {
  it("does not hand out more working tasks of a project than maxParallel", async () => {
    const p = await project({ maxParallel: 1 });
    await task(p.id, "a");
    await task(p.id, "b");
    const r = await runner();
    const first = (await claim(r)).body;
    expect((await claim(r)).status).toBe(204);
    await deliver(first); // leaves the working states (now REVIEW)
    expect((await claim(r)).status).toBe(200);
  });
});
