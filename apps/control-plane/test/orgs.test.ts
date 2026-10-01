import type { AgentDescriptor, AgentProfileDto, ClaimResponse, EventDto, ProjectDto, RunnerDto, TaskDto } from "@mar/core";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPgliteDb, type Db, migrate, Store } from "../src/index.js";

/** Organizations (spec §49) and the agent marketplace (spec §53). */

let db: Db;
let app: FastifyInstance;
let store: Store;

const users = [
  { name: "root", role: "owner" as const, token: "root-token-000000001", org: "*" },
  { name: "alice", role: "owner" as const, token: "alice-token-00000001", org: "acme" },
  { name: "bob", role: "owner" as const, token: "bob-token-0000000001", org: "globex" },
  { name: "acme-box", role: "runner" as const, token: "acme-runner-0000001", org: "acme" },
  { name: "globex-box", role: "runner" as const, token: "globex-runner-00001", org: "globex" },
];
const tokens = Object.fromEntries(users.map((u) => [u.name, u.token]));

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("truncate events, approvals, artifacts, executions, tasks, runners, projects, agent_profiles restart identity cascade");
  await db.query("delete from orgs where id <> 'default'");
  store = new Store(db);
  await store.ensureOrgs(["acme", "globex"]);
  app = buildApp(store, { users });
});
afterEach(() => app.close());

async function as<T>(who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokens[who]}` },
    ...(payload !== undefined && { payload: payload as object }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const agent = (id: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  id,
  adapter: "claude-code",
  capabilities: { pause: "checkpoint", resume: true, approval: "pre-tool-hook", structuredOutput: true, streaming: true, costReporting: false },
  ...extra,
});

async function project(who: string, key: string, extra: object = {}) {
  return (await as<ProjectDto>(who, "POST", "/projects", { key, name: key, repoUrl: "https://github.com/o/r.git", ...extra })).body;
}
const register = async (who: string, agents: AgentDescriptor[]) =>
  (await as<{ runnerId: string }>(who, "POST", "/runners/register", { name: who, agents })).body.runnerId;
const claim = async (who: string, runnerId: string) => (await as<ClaimResponse | undefined>(who, "POST", `/runners/${runnerId}/claim`)).body;

describe("organizations", () => {
  it("keep each organization's projects, tasks and events to itself", async () => {
    const acme = await project("alice", "ACME");
    expect(acme.orgId).toBe("acme");
    const globex = await project("bob", "GLX");
    const task = (await as<TaskDto>("alice", "POST", `/projects/${acme.id}/tasks`, { title: "t", objective: "o", agent: "claude" })).body;

    expect((await as<ProjectDto[]>("bob", "GET", "/projects")).body.map((p) => p.key)).toEqual(["GLX"]);
    expect((await as<ProjectDto[]>("root", "GET", "/projects")).body.map((p) => p.key)).toEqual(["ACME", "GLX"]);
    // Another organization's resources look as if they did not exist.
    expect((await as("bob", "GET", `/projects/${acme.id}`)).status).toBe(404);
    expect((await as("bob", "GET", `/tasks/${task.id}`)).status).toBe(404);
    expect((await as("bob", "POST", `/tasks/${task.id}/cancel`)).status).toBe(404);
    expect((await as("bob", "GET", `/events/recent?projectId=${acme.id}`)).status).toBe(404);
    expect((await as("bob", "GET", "/tasks/not-a-uuid")).status).toBe(404);
    const bobEvents = (await as<EventDto[]>("bob", "GET", "/events/recent")).body;
    expect(bobEvents.every((e) => e.projectId === globex.id)).toBe(true);

    expect((await as("alice", "POST", "/projects", { key: "XX", name: "x", repoUrl: "r", orgId: "globex" })).status).toBe(403);
    expect((await project("root", "ROOT", { orgId: "globex" })).orgId).toBe("globex");
  });

  it("give runners only their organization's work", async () => {
    const acme = await project("alice", "ACME");
    await project("bob", "GLX");
    await as("alice", "POST", `/projects/${acme.id}/tasks`, { title: "t", objective: "o", agent: "claude" });
    const globexRunner = await register("globex-box", [agent("claude")]);
    const acmeRunner = await register("acme-box", [agent("claude")]);
    expect(await claim("globex-box", globexRunner)).toBeFalsy();
    expect((await claim("acme-box", acmeRunner))?.project.key).toBe("ACME");
    expect((await as<RunnerDto[]>("bob", "GET", "/runners")).body.map((r) => r.name)).toEqual(["globex-box"]);
  });

  it("lets only platform admins create organizations", async () => {
    expect((await as("alice", "POST", "/orgs", { id: "initech", name: "Initech" })).status).toBe(403);
    expect((await as("root", "POST", "/orgs", { id: "initech", name: "Initech" })).status).toBe(201);
    expect((await as<{ id: string }[]>("alice", "GET", "/orgs")).body.map((o) => o.id)).toEqual(["acme"]);
  });

  it("limit a project to the agents it allows", async () => {
    const acme = await project("alice", "ACME", { allowedAgents: ["codex"] });
    const runner = await register("acme-box", [agent("claude", { skills: ["ts"] }), agent("codex", { adapter: "codex", skills: ["ts"] })]);
    await as("alice", "POST", `/projects/${acme.id}/tasks`, { title: "fixed", objective: "o", agent: "claude" });
    await as("alice", "POST", `/projects/${acme.id}/tasks`, { title: "auto", objective: "o", agent: "auto", requires: ["ts"] });
    const c = (await claim("acme-box", runner))!;
    expect(c.task).toMatchObject({ title: "auto", agent: "codex" });
    expect(await claim("acme-box", runner)).toBeFalsy();
  });
});

describe("agent marketplace", () => {
  const careful = {
    name: "careful-coder",
    adapter: "claude-code",
    description: "Small diffs, tests first.",
    skills: ["typescript", "backend"],
    cost: "high",
    instructions: "Write the failing test first. Keep diffs under 200 lines.",
  };

  it("publishes versioned profiles to the organization, and public ones to everyone", async () => {
    const v1 = (await as<AgentProfileDto>("alice", "POST", "/agent-profiles", careful)).body;
    const v2 = (await as<AgentProfileDto>("alice", "POST", "/agent-profiles", { ...careful, description: "v2" })).body;
    expect([v1.version, v2.version, v2.orgId]).toEqual([1, 2, "acme"]);
    expect((await as("alice", "POST", "/agent-profiles", { ...careful, public: true })).status).toBe(403);
    await as("root", "POST", "/agent-profiles", { name: "standard", adapter: "codex", public: true });

    expect((await as<AgentProfileDto[]>("bob", "GET", "/agent-profiles")).body.map((p) => p.name)).toEqual(["standard"]);
    expect((await as<AgentProfileDto[]>("alice", "GET", "/agent-profiles")).body.map((p) => `${p.name}@${p.version}`)).toEqual([
      "careful-coder@2",
      "careful-coder@1",
      "standard@1",
    ]);
    expect((await as("bob", "POST", `/agent-profiles/${v1.id}/deprecate`)).status).toBe(404);
    expect((await as<AgentProfileDto>("alice", "POST", `/agent-profiles/${v2.id}/deprecate`)).body.deprecated).toBe(true);
  });

  it("builds a runner's agent from a profile and gives its tasks the profile's instructions", async () => {
    await as("alice", "POST", "/agent-profiles", careful);
    const acme = await project("alice", "ACME");
    const runner = await register("acme-box", [agent("claude", { profile: "careful-coder" })]);
    const offered = (await as<RunnerDto[]>("alice", "GET", "/runners")).body[0]!.agents[0]!;
    expect(offered).toMatchObject({ profile: "careful-coder@1", skills: ["typescript", "backend"], cost: "high" });

    const task = (await as<TaskDto>("alice", "POST", `/projects/${acme.id}/tasks`, { title: "t", objective: "o", agent: "claude" })).body;
    const c = (await claim("acme-box", runner))!;
    expect(c.agentInstructions).toBe(careful.instructions);
    await as("acme-box", "POST", `/executions/${c.execution.id}/start`, { workspace: "/ws", branch: "task/ACME-1" });
    await as("acme-box", "POST", `/executions/${c.execution.id}/complete`, { exitCode: 1, terminal: { kind: "failed", reason: "boom" } });
    const listed = (await as<AgentProfileDto[]>("alice", "GET", "/agent-profiles")).body[0]!;
    expect(listed.usage).toEqual({ executions: 1, succeeded: 0, failed: 1 });
    expect(task.id).toBeTruthy();
  });

  it("refuses profiles that do not exist, belong to another organization, or need another adapter", async () => {
    await as("alice", "POST", "/agent-profiles", careful);
    expect((await as("acme-box", "POST", "/runners/register", { name: "x", agents: [agent("a", { profile: "nope" })] })).status).toBe(409);
    expect((await as("globex-box", "POST", "/runners/register", { name: "y", agents: [agent("a", { profile: "careful-coder" })] })).status).toBe(409);
    expect(
      (await as("acme-box", "POST", "/runners/register", { name: "z", agents: [agent("a", { adapter: "codex", profile: "careful-coder" })] })).status,
    ).toBe(409);
  });
});
