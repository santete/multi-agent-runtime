import type { AgentDescriptor, ClaimResponse, EventsPage, ProjectDto, QueueEntry, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Automatic reprioritization (spec §53). */

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

const create = async (title: string, extra: object = {}) =>
  (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title, objective: "o", agent: "claude", ...extra })).body;
const claimKey = async () => (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body.task.key;

describe("reprioritization", () => {
  it("takes urgent work first, regardless of age", async () => {
    await create("old, normal");
    await create("new, urgent", { priority: 90 });
    expect(await claimKey()).toBe("PAY-2");
    expect(await claimKey()).toBe("PAY-1");
  });

  it("raises work that others wait on (critical path) and work that has waited long", async () => {
    const leaf = await create("leaf");
    const root = await create("root");
    await create("waits for root", { dependsOn: [root.id] });
    await create("waits for that", { dependsOn: ["PAY-3"] });
    const queue = (await call<QueueEntry[]>("GET", `/projects/${project.id}/queue`)).body;
    expect(queue.map((e) => [e.key, e.score])).toEqual([
      ["PAY-2", 60],
      ["PAY-1", 50],
    ]);
    expect(queue[0]!.reasons).toEqual(["priority 50", "+10 unblocks 2 tasks"]);

    // An hour of waiting outweighs the critical path here.
    await db.query("update tasks set updated_at = now() - interval '2 hours' where id = $1", [leaf.id]);
    expect(await claimKey()).toBe("PAY-1");
  });

  it("lets people change a task's priority", async () => {
    const t = await create("t");
    const res = await call<TaskDto>("PUT", `/tasks/${t.id}/priority`, { priority: 80 });
    expect(res.body.priority).toBe(80);
    expect((await call("PUT", `/tasks/${t.id}/priority`, { priority: 101 })).status).toBe(400);
    const events = (await call<EventsPage>("GET", `/tasks/${t.id}/events`)).body.events;
    expect(events.find((e) => e.type === "TaskReprioritized")?.payload).toMatchObject({ from: 50, to: 80 });
  });
});
