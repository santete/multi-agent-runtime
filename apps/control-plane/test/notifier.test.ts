import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentDescriptor, ClaimResponse, PlanDto, ProjectDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Notifier, notifierOptionsFromEnv, Store } from "../src/index.js";

/** Notifications to Slack-compatible webhooks (spec §31). */

let db: Db;
let app: FastifyInstance;
let store: Store;
let hook: Server;
let hookUrl: string;
let received: Array<{ text: string }> = [];
let failNext = 0;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(503).end();
        return;
      }
      received.push(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/services/T/B/secret`;
});
afterAll(async () => {
  await db.close();
  await new Promise((r) => hook.close(r));
});
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects, event_cursors restart identity cascade");
  store = new Store(db);
  app = buildApp(store);
  received = [];
  failNext = 0;
});
afterEach(() => app.close());

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent: AgentDescriptor = {
  id: "claude",
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
};

const notifier = (kinds?: Parameters<typeof notifierOptionsFromEnv>[0]["MAR_NOTIFY_EVENTS"]) =>
  new Notifier(store, {
    ...notifierOptionsFromEnv({ MAR_NOTIFY_WEBHOOKS: hookUrl, ...(kinds && { MAR_NOTIFY_EVENTS: kinds }) }, "http://mar.test")!,
    retryDelaysMs: [10],
  });

async function setup() {
  const project = (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  const runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent] })).body.runnerId;
  return { project, runnerId };
}

/** Runs the claimed execution to REVIEW. */
async function deliver(c: ClaimResponse) {
  const id = c.execution.id;
  await call("POST", `/executions/${id}/start`, { workspace: "/ws", branch: `task/${c.task.key}` });
  await call("POST", `/executions/${id}/complete`, {
    exitCode: 0,
    terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result: { summary: "done" } },
  });
  await call("POST", `/executions/${id}/validation`, { passed: true, steps: [], changedFiles: [] });
  await call("POST", `/executions/${id}/delivery`, { branch: `task/${c.task.key}`, commitSha: "abc1234", changedFiles: [] });
}

describe("notifier", () => {
  it("starts at the end of the log, then tells people what needs them", async () => {
    const n = notifier();
    const { project, runnerId } = await setup();
    await call("POST", `/projects/${project.id}/tasks`, { title: "Old", objective: "o", agent: "claude" });
    // First run: history is not replayed.
    expect(await n.poll()).toBe(0);

    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refund API", objective: "o", agent: "claude" })).body;
    await claim(runnerId);
    await deliver(await claim(runnerId));
    expect(await n.poll()).toBe(1);
    expect(received).toEqual([
      { text: `:eyes: *Review needed* — *PAY-2* Refund API by \`claude\`. <http://mar.test/ui/#/tasks/${task.id}|Open task>` },
    ]);
    // Nothing new: nothing sent again.
    expect(await n.poll()).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("notifies approvals, proposed plans and blocked tasks", async () => {
    const n = notifier();
    await n.poll();
    const { project, runnerId } = await setup();
    const plan = (await call<PlanDto>("POST", `/projects/${project.id}/plans`, { goal: "Add refunds\nwith care", agent: "claude" })).body;
    const c = await claim(runnerId);
    await call("POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/PAY-1" });
    const verdict = await app.inject({
      method: "POST",
      url: `/executions/${c.execution.id}/tool-check`,
      headers: { "x-mar-execution-token": c.executionToken },
      payload: { tool: "Bash", input: { command: "curl https://example.com" } },
    });
    expect(verdict.json().decision).toBe("deny");
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: {
        kind: "completed",
        sessionId: "s",
        success: true,
        deniedActions: [],
        result: { summary: "s", tasks: [{ ref: "T1", title: "t", objective: "o", agent: null, requires: [], dependsOn: [] }], knowledge: [] },
      },
    });

    await n.poll();
    const texts = received.map((r) => r.text);
    expect(texts).toContainEqual(expect.stringMatching(/^:warning: \*Approval needed\* \(HIGH\) — \*PAY-1\* Plan: Add refunds with care: the agent wants to run `.*curl.*`/));
    expect(texts).toContainEqual(expect.stringContaining(":octagonal_sign: *PAY-1* Plan: Add refunds with care is waiting for a person."));
    expect(plan.status).toBe("planning");
  });

  it("only sends the kinds it is configured for", async () => {
    const n = notifier("merged");
    await n.poll();
    const { project, runnerId } = await setup();
    const task = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "Refund API", objective: "o", agent: "claude" })).body;
    await deliver(await claim(runnerId));
    await call("POST", `/tasks/${task.id}/review`, { decision: "approve" });
    await store.processMergeQueue();
    await n.poll();
    expect(received.map((r) => r.text)).toEqual([":white_check_mark: *PAY-1* Refund API merged."]);
  });

  it("retries a webhook that is briefly down and keeps going when it stays down", async () => {
    const n = notifier("review");
    await n.poll();
    const { project, runnerId } = await setup();
    await call("POST", `/projects/${project.id}/tasks`, { title: "A", objective: "o", agent: "claude" });
    await deliver(await claim(runnerId));
    failNext = 1;
    await n.poll();
    expect(received).toHaveLength(1);

    await call("POST", `/projects/${project.id}/tasks`, { title: "B", objective: "o", agent: "claude" });
    await deliver(await claim(runnerId));
    failNext = 5;
    await n.poll();
    // Given up after the retries; the cursor moved on.
    expect(received).toHaveLength(1);
    expect(await store.eventCursor("notifier")).toBe(await store.latestEventSeq());
  });

  it("skips events too old to act on when catching up", async () => {
    const n = notifier("review");
    await n.poll();
    const { project, runnerId } = await setup();
    await call("POST", `/projects/${project.id}/tasks`, { title: "Stale", objective: "o", agent: "claude" });
    await deliver(await claim(runnerId));
    // As if notifications had been off for two hours.
    await db.query("update events set created_at = now() - interval '2 hours'");
    expect(await n.poll()).toBe(0);
    expect(received).toEqual([]);
    expect(await store.eventCursor("notifier")).toBe(await store.latestEventSeq());
  });

  it("is off without webhooks", () => {
    expect(notifierOptionsFromEnv({}, "http://x")).toBeNull();
    expect(notifierOptionsFromEnv({ MAR_NOTIFY_WEBHOOKS: "https://a, https://b", MAR_NOTIFY_EVENTS: "plan,bogus" }, "http://x")).toEqual({
      webhooks: ["https://a", "https://b"],
      kinds: ["plan"],
      publicUrl: "http://x",
    });
  });
});

const claim = async (runnerId: string) => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
