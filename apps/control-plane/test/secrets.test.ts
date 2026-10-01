import type { AgentDescriptor, ArtifactDto, ClaimResponse, EventsPage, ExecutionSecret, ProjectDto, SecretDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Secret management (spec §48). */

const TOKEN = "npm_live_0123456789abcdef";

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
  await start("a-long-enough-secrets-key");
});
afterEach(() => app.close());

async function start(secretsKey?: string) {
  app = buildApp(new Store(db, { secretsKey }));
  const projects = (await call<ProjectDto[]>("GET", "/projects")).body;
  project = projects[0] ?? (await call<ProjectDto>("POST", "/projects", { key: "PAY", name: "p", repoUrl: "https://github.com/o/r.git" })).body;
  runnerId = (await call<{ runnerId: string }>("POST", "/runners/register", { name: "box", agents: [agent] })).body.runnerId;
}

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent: AgentDescriptor = {
  id: "claude",
  adapter: "claude",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
};

async function running() {
  const t = (await call<TaskDto>("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "claude" })).body;
  const c = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
  return { t, c };
}
const check = (c: ClaimResponse, payload: object) =>
  app
    .inject({ method: "POST", url: `/executions/${c.execution.id}/tool-check`, headers: { "x-mar-execution-token": c.executionToken }, payload })
    .then((res) => res.json());

describe("secrets", () => {
  it("stores values encrypted and never returns them", async () => {
    const saved = await call<SecretDto>("PUT", `/projects/${project.id}/secrets/NPM_TOKEN`, { value: TOKEN, exposeTo: ["agent", "validation"] });
    expect(saved.body).toMatchObject({ name: "NPM_TOKEN", source: "stored", ref: null, exposeTo: ["agent", "validation"] });
    expect(JSON.stringify((await call("GET", `/projects/${project.id}/secrets`)).body)).not.toContain(TOKEN);
    const [row] = await db.query<{ ciphertext: Uint8Array }>("select ciphertext from secrets");
    expect(Buffer.from(row!.ciphertext).toString("utf8")).not.toContain(TOKEN);
    const events = (await call<EventsPage>("GET", `/projects/${project.id}/events`)).body.events;
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    expect((await call("PUT", `/projects/${project.id}/secrets/npm-token`, { value: "x", exposeTo: ["agent"] })).status).toBe(400);
    expect((await call("PUT", `/projects/${project.id}/secrets/A`, { value: "x", fromRunnerEnv: "B", exposeTo: ["agent"] })).status).toBe(400);
    expect((await call("DELETE", `/projects/${project.id}/secrets/NPM_TOKEN`)).status).toBe(204);
    expect((await call("DELETE", `/projects/${project.id}/secrets/NPM_TOKEN`)).status).toBe(404);
  });

  it("refuses to store values without MAR_SECRETS_KEY, but takes runner-env secrets", async () => {
    await app.close();
    await start(undefined);
    const stored = await call<{ message: string }>("PUT", `/projects/${project.id}/secrets/NPM_TOKEN`, { value: TOKEN, exposeTo: ["agent"] });
    expect(stored.status).toBe(409);
    expect(stored.body.message).toContain("MAR_SECRETS_KEY");
    const ref = await call<SecretDto>("PUT", `/projects/${project.id}/secrets/NPM_TOKEN`, { fromRunnerEnv: "SANDBOX_NPM_TOKEN", exposeTo: ["agent"] });
    expect(ref.body).toMatchObject({ source: "runner-env", ref: "SANDBOX_NPM_TOKEN" });
  });

  it("gives names with the claim and values only to the runner of an active execution", async () => {
    await call("PUT", `/projects/${project.id}/secrets/NPM_TOKEN`, { value: TOKEN, exposeTo: ["agent"] });
    await call("PUT", `/projects/${project.id}/secrets/DB_URL`, { fromRunnerEnv: "LOCAL_DB_URL", exposeTo: ["validation"] });
    const { t, c } = await running();
    expect(c.secrets).toEqual([
      { name: "DB_URL", exposeTo: ["validation"] },
      { name: "NPM_TOKEN", exposeTo: ["agent"] },
    ]);
    expect(JSON.stringify(c)).not.toContain(TOKEN);

    const issued = await call<ExecutionSecret[]>("GET", `/executions/${c.execution.id}/secrets`);
    expect(issued.body).toEqual([
      { name: "DB_URL", exposeTo: ["validation"], fromRunnerEnv: "LOCAL_DB_URL" },
      { name: "NPM_TOKEN", exposeTo: ["agent"], value: TOKEN },
    ]);
    const events = (await call<EventsPage>("GET", `/tasks/${t.id}/events`)).body.events;
    expect(events.find((e) => e.type === "SecretsIssued")?.payload).toEqual({ names: ["DB_URL", "NPM_TOKEN"] });

    await call("POST", `/tasks/${t.id}/cancel`);
    await call("POST", `/executions/${c.execution.id}/complete`, { exitCode: null, terminal: { kind: "failed", reason: "cancelled" } });
    expect((await call("GET", `/executions/${c.execution.id}/secrets`)).status).toBe(409);
  });

  it("refuses calls that print or carry a secret, and records everything without the value", async () => {
    await call("PUT", `/projects/${project.id}/secrets/NPM_TOKEN`, { value: TOKEN, exposeTo: ["agent"] });
    const { t, c } = await running();

    expect(await check(c, { tool: "Bash", input: { command: "echo $NPM_TOKEN" } })).toMatchObject({ decision: "deny", risk: "HIGH" });
    expect(await check(c, { tool: "Write", input: { file_path: ".npmrc", content: `//registry.npmjs.org/:_authToken=${TOKEN}` } })).toMatchObject({
      decision: "deny",
      risk: "CRITICAL",
      reason: expect.stringContaining("contains a secret value"),
    });
    // A runner-env secret: the hook redacted it and says so.
    expect(await check(c, { tool: "Write", input: { file_path: "a.txt", content: "[secret OTHER]" }, containsSecret: "OTHER" })).toMatchObject({
      decision: "deny",
      risk: "CRITICAL",
    });
    expect(await check(c, { tool: "Bash", input: { command: "npm whoami" } })).toMatchObject({ decision: "allow" });

    await call("POST", `/executions/${c.execution.id}/events`, { events: [{ kind: "message", text: `token is ${TOKEN}` }] });
    await call("POST", `/executions/${c.execution.id}/complete`, {
      exitCode: 0,
      terminal: { kind: "completed", sessionId: "s", success: true, deniedActions: [], result: { summary: `used ${TOKEN}` } },
      diff: `diff --git a/x b/x\n+${TOKEN}\n`,
    });

    const all = JSON.stringify([
      (await call<EventsPage>("GET", `/tasks/${t.id}/events?limit=1000`)).body,
      (await call<EventsPage>("GET", `/executions/${c.execution.id}/events`)).body,
      (await call("GET", "/approvals")).body,
      (await call<ArtifactDto[]>("GET", `/tasks/${t.id}/artifacts`)).body,
    ]);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("[secret NPM_TOKEN]");
  });
});
