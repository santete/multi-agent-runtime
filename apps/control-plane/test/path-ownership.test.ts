import type { AgentDescriptor, ClaimResponse, EventsPage, ProjectDto, QueueEntry, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Path ownership (spec §27). */

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

const create = async (title: string, paths?: string[]) =>
  (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title, objective: "o", agent: "claude", ...(paths && { paths }) })).body;
const claim = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;

describe("path ownership", () => {
  it("stores the declared area", async () => {
    const t = await create("refunds", ["src/payments/**", " README.md "]);
    expect(t.paths).toEqual(["src/payments/**", "README.md"]);
    expect((await create("no area")).paths).toEqual([]);
  });

  it("runs tasks with overlapping areas one after the other", async () => {
    await create("refunds", ["src/payments/**"]);
    await create("receipts", ["src/payments/receipt.js"]);
    await create("export", ["src/export/**"]);
    await create("undeclared");

    expect((await claim()).task.key).toBe("PAY-1");
    const queue = (await call<QueueEntry[]>("GET", `/projects/${project.id}/queue`)).body;
    expect(queue.find((e) => e.key === "PAY-2")!.blockedBy).toEqual({ key: "PAY-1", path: "src/payments/**" });
    expect(queue.find((e) => e.key === "PAY-3")!.blockedBy).toBeNull();

    // PAY-2 is skipped while PAY-1 is unmerged; disjoint and undeclared work goes ahead.
    expect((await claim()).task.key).toBe("PAY-3");
    expect((await claim()).task.key).toBe("PAY-4");
    expect((await call("POST", `/runners/${runnerId}/claim`)).status).toBe(204);

    const pay2 = (await call<TaskDto[]>("GET", `/projects/${project.id}/tasks`)).body.find((t) => t.key === "PAY-2")!;
    const events = (await call<EventsPage>("GET", `/tasks/${pay2.id}/events`)).body.events;
    expect(events.filter((e) => e.type === "TaskWaitingForPaths")).toHaveLength(1);

    // Once PAY-1 is done with, PAY-2 can start.
    await db.query("update tasks set state = 'COMPLETED' where key = 'PAY-1'");
    expect((await claim()).task.key).toBe("PAY-2");
  });

  it("denies writes into another unmerged task's area as a HIGH-risk action", async () => {
    await create("refunds", ["src/payments/**"]);
    await create("export", ["src/export/**"]);
    const first = await claim();
    const second = await claim();
    for (const c of [first, second]) {
      await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: `task/${c.task.key}` });
    }
    const check = (c: ClaimResponse, file: string) =>
      app
        .inject({
          method: "POST",
          url: `/executions/${c.execution.id}/tool-check`,
          headers: { "x-mar-execution-token": c.executionToken },
          payload: { tool: "Write", input: { file_path: file, content: "x" } },
        })
        .then((res) => res.json());

    expect(await check(second, "C:\\ws\\src\\export\\csv.js")).toMatchObject({ decision: "allow" });
    expect(await check(second, "C:\\ws\\docs\\notes.md")).toMatchObject({ decision: "allow" });
    expect(await check(second, "C:\\ws\\src\\payments\\refund.js")).toMatchObject({
      decision: "deny",
      risk: "HIGH",
      reason: expect.stringContaining("requires human approval"),
    });
    const [approval] = (await call<Array<{ reason: string }>>("GET", "/approvals?status=pending")).body;
    expect(approval!.reason).toContain("belongs to PAY-1");
  });
});
