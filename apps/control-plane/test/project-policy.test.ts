import type { AgentDescriptor, ApprovalDto, ClaimResponse, ProjectDto, ProjectPolicy } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Project-level policy (spec §47). */

let db: Db;
let store: Store;
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
  store = new Store(db);
  app = buildApp(store);
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

const policy: ProjectPolicy = {
  rules: [
    { kind: "write", pattern: "config/production/**", action: "approve", reason: "production configuration" },
    { kind: "command", pattern: "\\bdrop\\s+table\\b", action: "deny", reason: "dropping tables" },
  ],
  allowedHosts: ["api.example.com"],
  approveMedium: false,
  approvers: { MEDIUM: "member", HIGH: "owner", CRITICAL: null },
};

async function running() {
  await call("POST", `/projects/${project.id}/tasks`, { title: "t", objective: "o", agent: "claude" });
  const c = (await call<ClaimResponse>("POST", `/runners/${runnerId}/claim`)).body;
  await call("POST", `/executions/${c.execution.id}/start`, { workspace: "C:\\ws", branch: "task/PAY-1" });
  return c;
}
const check = (c: ClaimResponse, tool: string, input: object) =>
  app
    .inject({ method: "POST", url: `/executions/${c.execution.id}/tool-check`, headers: { "x-mar-execution-token": c.executionToken }, payload: { tool, input } })
    .then((res) => res.json());

describe("project policy", () => {
  it("is stored, validated and sent to the runner with the claim", async () => {
    expect((await call<ProjectDto>("GET", `/projects/${project.id}`)).body.policy).toEqual({
      rules: [],
      allowedHosts: [],
      approveMedium: false,
      approvers: { MEDIUM: "member", HIGH: "senior", CRITICAL: null },
    });
    const saved = await call<ProjectDto>("PUT", `/projects/${project.id}/policy`, policy);
    expect(saved.body.policy).toEqual(policy);
    const bad = { ...policy, rules: [{ kind: "command", pattern: "([", action: "deny", reason: "x" }] };
    expect((await call("PUT", `/projects/${project.id}/policy`, bad)).status).toBe(400);
    expect((await call("PUT", `/projects/${project.id}/policy`, { ...policy, allowedHosts: ["https://x.com/"] })).status).toBe(400);

    const c = await running();
    expect(c.project.policy).toEqual(policy);
  });

  it("applies the project's rules to tool calls and approvals", async () => {
    await call("PUT", `/projects/${project.id}/policy`, policy);
    const c = await running();

    expect(await check(c, "Write", { file_path: "C:\\ws\\config\\production\\db.json" })).toMatchObject({
      decision: "deny",
      risk: "HIGH",
      reason: expect.stringMatching(/project policy: production configuration; requires human approval/),
    });
    expect(await check(c, "Bash", { command: "psql -c 'drop table payments'" })).toMatchObject({ decision: "deny", risk: "CRITICAL" });
    expect(await check(c, "Bash", { command: "curl https://api.example.com/rates" })).toMatchObject({ decision: "allow" });

    // HIGH needs an owner in this project, not just a senior.
    const [approval] = (await call<ApprovalDto[]>("GET", "/approvals?status=pending")).body;
    await expect(store.decideApproval(approval!.id, "approved", undefined, { name: "sam", role: "senior", org: "*" })).rejects.toThrow(
      "HIGH risk approvals require role owner",
    );
    expect((await store.decideApproval(approval!.id, "approved", undefined, { name: "olga", role: "owner", org: "*" })).status).toBe("approved");
    expect(await check(c, "Write", { file_path: "C:\\ws\\config\\production\\db.json" })).toMatchObject({ decision: "allow" });
  });

  it("can make CRITICAL actions approvable by an owner", async () => {
    await call("PUT", `/projects/${project.id}/policy`, { ...policy, approvers: { ...policy.approvers, CRITICAL: "owner" } });
    const c = await running();
    expect(await check(c, "Bash", { command: "git push origin task/PAY-1" })).toMatchObject({
      decision: "deny",
      risk: "CRITICAL",
      reason: expect.stringContaining("requires human approval"),
    });
    const [approval] = (await call<ApprovalDto[]>("GET", "/approvals?status=pending")).body;
    expect(approval!.risk).toBe("CRITICAL");
  });
});
