import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { InvalidTransitionError, KNOWLEDGE_KINDS } from "@mar/core";
import {
  type Context,
  contextWithSpan,
  extractTraceContext,
  runInContext,
  type Span,
  SpanKind,
  SpanStatusCode,
  startSpan,
} from "@mar/telemetry";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { type Actor, Authenticator, type Role, type UserConfig, hasRole } from "./auth.js";
import { ConflictError, ForbiddenError, NotFoundError, type Store, UnauthorizedError } from "./store.js";

export const EXECUTION_TOKEN_HEADER = "x-mar-execution-token";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
    /** Server span of the request, a child of the caller's trace (runner, policy hook). */
    otel?: { span: Span; context: Context };
  }
  interface FastifyContextConfig {
    /** Minimum role for the route (default: viewer). */
    role?: Role;
    /** No API token (health; tool-check uses the execution token). */
    public?: boolean;
  }
}

export interface AppOptions extends FastifyServerOptions {
  /** API users; none (and no apiToken) = open mode, every caller is the local owner. */
  users?: UserConfig[] | undefined;
  /** Shorthand for a single owner token. */
  apiToken?: string | undefined;
  /** Built web UI (apps/web/dist), served under /ui/. */
  webRoot?: string | undefined;
  /** How often the event stream polls for new events. */
  streamPollMs?: number | undefined;
}

const idParams = z.object({ id: z.uuid() });

const validationSteps = z
  .array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      timeoutSeconds: z.number().int().positive().max(7200).optional(),
    }),
  )
  .max(20);

const validationSandbox = z.object({
  // An image reference: registry/name:tag or @digest, nothing a shell could interpret.
  image: z.string().regex(/^[\w][\w.\-/:@]{0,254}$/, "invalid image reference"),
  network: z.boolean().optional(),
  memory: z.string().regex(/^\d+[kmg]?$/i).optional(),
  cpus: z.number().positive().max(64).optional(),
});

const budget = z.object({
  dailyUsd: z.number().positive().optional(),
  perTaskUsd: z.number().positive().optional(),
});

const createProjectBody = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,15}$/, "2-16 chars, uppercase letters/digits, starting with a letter"),
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  validation: validationSteps.optional(),
  maxParallel: z.number().int().min(1).max(100).optional(),
  reviewAgents: z.array(z.string().min(1)).max(10).optional(),
  autoApproveOnAgentReview: z.boolean().optional(),
  routingPolicy: z.enum(["balanced", "reliability", "cost"]).optional(),
  revalidateOnBaseChange: z.boolean().optional(),
  waitForChecks: z.boolean().optional(),
  validationSandbox: validationSandbox.nullable().optional(),
  budget: budget.nullable().optional(),
});

const mergePolicyBody = z.object({ revalidateOnBaseChange: z.boolean(), waitForChecks: z.boolean() });

const reviewPolicyBody = z.object({
  reviewAgents: z.array(z.string().min(1)).max(10),
  autoApproveOnAgentReview: z.boolean().default(false),
});

const validationReportBody = z.object({
  passed: z.boolean(),
  steps: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      outputTail: z.string().max(20_000),
    }),
  ),
  changedFiles: z.array(z.string()).max(5000),
});

const deliveryBody = z.object({
  branch: z.string().min(1),
  commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  changedFiles: z.array(z.string()).max(5000),
  error: z.string().max(4000).optional(),
});

const createTaskBody = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  /** An agent id, or "auto" to route by `requires`. */
  agent: z.string().min(1),
  requires: z.array(z.string().min(1)).max(20).optional(),
  fallbackAgents: z.array(z.string().min(1)).max(10).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  dependsOn: z.array(z.string().min(1)).max(50).optional(),
});

const createPlanBody = z.object({
  goal: z.string().min(1).max(20_000),
  /** The planner agent, or "auto". */
  agent: z.string().min(1),
});

const plannedTask = z.object({
  ref: z.string().min(1).max(40),
  title: z.string().min(1),
  objective: z.string().min(1),
  agent: z.string().min(1).nullable(),
  requires: z.array(z.string().min(1)).max(20).default([]),
  dependsOn: z.array(z.string().min(1)).max(50).default([]),
});
const approvePlanBody = z
  .object({ tasks: z.array(plannedTask).min(1).max(20).optional(), comment: z.string().max(10_000).optional() })
  .default({});
const revisePlanBody = z.object({ feedback: z.string().min(1).max(10_000) });

const knowledgeKind = z.enum(KNOWLEDGE_KINDS);
const createKnowledgeBody = z.object({
  kind: knowledgeKind,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
});
const updateKnowledgeBody = z.object({
  kind: knowledgeKind.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(["proposed", "accepted", "archived"]).optional(),
});
const knowledgeQuery = z.object({ status: z.enum(["proposed", "accepted", "archived"]).optional() });

const reviewBody = z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(10_000).optional() });
const decisionBody = z.object({ comment: z.string().max(10_000).optional() }).default({});
const approvalsQuery = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() });

const capabilities = z.object({
  pause: z.enum(["native", "checkpoint", "none"]),
  resume: z.boolean(),
  approval: z.enum(["pre-tool-hook", "static-rules", "sandbox", "none"]),
  structuredOutput: z.boolean(),
  streaming: z.boolean(),
  costReporting: z.boolean(),
});

const registerRunnerBody = z.object({
  name: z.string().min(1),
  agents: z.array(
    z.object({
      id: z.string().min(1),
      adapter: z.string().min(1),
      capabilities,
      skills: z.array(z.string().min(1)).max(50).optional(),
      cost: z.enum(["low", "medium", "high"]).optional(),
      pricing: z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }).optional(),
      maxConcurrent: z.number().int().min(1).max(100).optional(),
    }),
  ),
});

const startExecutionBody = z.object({ workspace: z.string().min(1), branch: z.string().min(1) });

// Agent events are produced by our own adapters; validate the envelope only.
const agentEvent = z.looseObject({ kind: z.string() });
const appendEventsBody = z.object({ events: z.array(agentEvent).max(500) });

const completeExecutionBody = z.object({
  exitCode: z.number().int().nullable(),
  terminal: z.discriminatedUnion("kind", [
    z.looseObject({
      kind: z.literal("completed"),
      sessionId: z.string(),
      success: z.boolean(),
      deniedActions: z.array(z.string()),
      result: z.unknown(),
    }),
    z.looseObject({ kind: z.literal("failed"), reason: z.string(), sessionId: z.string().optional() }),
  ]),
  revalidation: z.boolean().optional(),
});

const toolCheckBody = z.object({ tool: z.string().min(1), input: z.unknown() });

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const streamQuery = z.object({
  projectId: z.uuid().optional(),
  after: z.coerce.number().int().min(0).optional(),
});

const gcBody = z.object({ taskKeys: z.array(z.string().min(1)).max(1000) });

const recentQuery = z.object({
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const role = (min: Role) => ({ config: { role: min } });

const NOT_TRACED = new Set(["/stream", "/health", "/executions/:id/heartbeat", "/executions/:id/events"]);

/** Execution routes carry the execution id: worth a span attribute. */
function executionAttributes(params: unknown): Record<string, string> {
  const id = (params as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? { "mar.resource.id": id } : {};
}
const PUBLIC = { config: { public: true } };

export function buildApp(store: Store, opts: AppOptions = {}): FastifyInstance {
  const { users, apiToken, webRoot, streamPollMs = 1000, ...fastifyOpts } = opts;
  const app = Fastify(fastifyOpts);
  const auth = new Authenticator([
    ...(users ?? []),
    ...(apiToken ? [{ name: "admin", role: "owner" as const, token: apiToken }] : []),
  ]);

  app.decorateRequest("actor", null as unknown as Actor);

  // Tracing (spec §41): every API request is a server span in the caller's trace;
  // handlers run in its context so store and GitHub spans nest under it.
  app.decorateRequest("otel", undefined);
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = function (this: unknown, req, reply) {
      return req.otel ? runInContext(req.otel.context, () => handler.call(this as never, req, reply)) : handler.call(this as never, req, reply);
    };
  });
  app.addHook("onRequest", async (req) => {
    const route = req.routeOptions.url;
    // Long-lived streams, static files and the runner's periodic heartbeats and event batches are not worth a span.
    if (!route || NOT_TRACED.has(route) || route.startsWith("/ui")) return;
    const parent = extractTraceContext(req.headers);
    const span = startSpan(
      `${req.method} ${route}`,
      { "http.request.method": req.method, "http.route": route, ...executionAttributes(req.params) },
      parent,
      SpanKind.SERVER,
    );
    req.otel = { span, context: contextWithSpan(span, parent) };
  });
  app.addHook("onResponse", async (req, reply) => {
    if (!req.otel) return;
    req.otel.span.setAttribute("http.response.status_code", reply.statusCode);
    if (reply.statusCode >= 500) req.otel.span.setStatus({ code: SpanStatusCode.ERROR });
    req.otel.span.end();
  });
  app.addHook("onRequest", async (req, reply) => {
    const url = req.routeOptions.url;
    // Static UI files and unmatched routes (404) need no token.
    if (req.routeOptions.config?.public || !url || url.startsWith("/ui")) return;
    const actor = auth.authenticate(req.headers.authorization);
    if (!actor) return reply.status(401).send({ error: "unauthorized" });
    const min = req.routeOptions.config?.role ?? "viewer";
    if (!hasRole(actor, min)) return reply.status(403).send({ error: "forbidden", message: `requires role ${min}` });
    req.actor = actor;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "not_found", message: err.message });
    if (err instanceof UnauthorizedError) return reply.status(401).send({ error: "unauthorized" });
    if (err instanceof ForbiddenError) return reply.status(403).send({ error: "forbidden", message: err.message });
    if (err instanceof ConflictError || err instanceof InvalidTransitionError) {
      return reply.status(409).send({ error: "conflict", message: err.message });
    }
    if ((err as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: "bad_request" });
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.get("/health", PUBLIC, async () => ({ ok: true }));
  app.get("/me", (req) => req.actor);

  if (webRoot && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot, prefix: "/ui/" });
    app.get("/", PUBLIC, (_req, reply) => reply.redirect("/ui/"));
  }

  // ---- projects & tasks ---------------------------------------------------

  app.post("/projects", role("owner"), async (req, reply) => {
    reply.status(201);
    return store.createProject(createProjectBody.parse(req.body));
  });
  app.get("/projects", () => store.listProjects());
  app.get("/projects/:id", (req) => store.getProject(idParams.parse(req.params).id));
  app.put("/projects/:id/review", role("owner"), (req) =>
    store.setReviewPolicy(idParams.parse(req.params).id, reviewPolicyBody.parse(req.body)),
  );
  app.put("/projects/:id/validation-sandbox", role("owner"), (req) =>
    store.setValidationSandbox(idParams.parse(req.params).id, validationSandbox.nullable().parse(req.body ?? null)),
  );
  app.put("/projects/:id/merge-policy", role("owner"), (req) =>
    store.setMergePolicy(idParams.parse(req.params).id, mergePolicyBody.parse(req.body)),
  );
  app.put("/projects/:id/validation", role("owner"), (req) =>
    store.setValidation(idParams.parse(req.params).id, validationSteps.parse(req.body)),
  );

  app.post("/projects/:id/tasks", role("member"), async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = createTaskBody.parse(req.body);
    reply.status(201);
    return store.createTask(id, body, req.actor.name);
  });
  app.get("/projects/:id/tasks", (req) => store.listTasks(idParams.parse(req.params).id));
  app.get("/projects/:id/graph", (req) => store.graph(idParams.parse(req.params).id));
  app.get("/projects/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ projectId: idParams.parse(req.params).id }, after, limit), after);
  });

  // Assisted planning (spec §24): a planner agent proposes a task DAG, a human decides.
  app.post("/projects/:id/plans", role("member"), async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = createPlanBody.parse(req.body);
    reply.status(201);
    return store.createPlan(id, body, req.actor.name);
  });
  app.get("/projects/:id/plans", (req) => store.listPlans(idParams.parse(req.params).id));
  app.get("/plans/:id", (req) => store.getPlan(idParams.parse(req.params).id));
  app.post("/plans/:id/approve", role("member"), (req) =>
    store.approvePlan(idParams.parse(req.params).id, approvePlanBody.parse(req.body ?? {}), req.actor.name),
  );
  app.post("/plans/:id/revise", role("member"), async (req, reply) => {
    const plan = await store.revisePlan(idParams.parse(req.params).id, revisePlanBody.parse(req.body), req.actor.name);
    reply.status(201);
    return plan;
  });
  app.post("/plans/:id/reject", role("member"), (req) =>
    store.rejectPlan(idParams.parse(req.params).id, decisionBody.parse(req.body ?? {}).comment, req.actor.name),
  );

  // Shared knowledge base (spec §20, §35): agents propose, merges and people accept.
  app.get("/projects/:id/knowledge", (req) =>
    store.listKnowledge(idParams.parse(req.params).id, knowledgeQuery.parse(req.query).status),
  );
  app.post("/projects/:id/knowledge", role("member"), async (req, reply) => {
    const entry = await store.createKnowledge(idParams.parse(req.params).id, createKnowledgeBody.parse(req.body), req.actor.name);
    reply.status(201);
    return entry;
  });
  app.get("/knowledge/:id", (req) => store.getKnowledge(idParams.parse(req.params).id));
  app.put("/knowledge/:id", role("member"), (req) =>
    store.updateKnowledge(idParams.parse(req.params).id, updateKnowledgeBody.parse(req.body), req.actor.name),
  );

  app.get("/tasks/:id", (req) => store.getTask(idParams.parse(req.params).id));
  app.post("/tasks/:id/cancel", role("member"), (req) => store.cancelTask(idParams.parse(req.params).id, req.actor.name));
  app.post("/tasks/:id/retry", role("member"), (req) => store.retryTask(idParams.parse(req.params).id, req.actor.name));
  app.post("/tasks/:id/review", role("member"), (req) =>
    store.reviewTask(idParams.parse(req.params).id, reviewBody.parse(req.body), req.actor.name),
  );
  app.get("/tasks/:id/approvals", (req) => store.listApprovals({ taskId: idParams.parse(req.params).id }));
  app.get("/tasks/:id/executions", (req) => store.listExecutions(idParams.parse(req.params).id));
  app.get("/tasks/:id/artifacts", (req) => store.listArtifacts(idParams.parse(req.params).id));
  app.get("/tasks/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ taskId: idParams.parse(req.params).id }, after, limit), after);
  });

  // ---- approval gateway ---------------------------------------------------

  app.get("/approvals", (req) => {
    const { status } = approvalsQuery.parse(req.query);
    return store.listApprovals(status ? { status } : {});
  });
  // The store enforces the risk-specific role (HIGH needs senior).
  app.post("/approvals/:id/approve", role("member"), (req) =>
    store.decideApproval(idParams.parse(req.params).id, "approved", decisionBody.parse(req.body ?? {}).comment, req.actor),
  );
  app.post("/approvals/:id/reject", role("member"), (req) =>
    store.decideApproval(idParams.parse(req.params).id, "rejected", decisionBody.parse(req.body ?? {}).comment, req.actor),
  );

  // ---- live events (server-sent events) -----------------------------------

  app.get("/events/recent", (req) => {
    const { projectId, limit } = recentQuery.parse(req.query);
    return store.recentEvents(limit, projectId);
  });

  app.get("/stream", async (req, reply) => {
    const { projectId, after } = streamQuery.parse(req.query);
    let cursor = after ?? (await store.latestEventSeq());
    let open = true;
    req.raw.on("close", () => {
      open = false;
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(`: connected at ${cursor}\n\n`);
    let idle = 0;
    while (open) {
      const events = await store.listEvents(projectId ? { projectId } : {}, cursor, 500);
      for (const e of events) reply.raw.write(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
      if (events.length) {
        cursor = events.at(-1)!.seq;
        idle = 0;
      } else if ((idle += streamPollMs) >= 15_000) {
        reply.raw.write(": keep-alive\n\n");
        idle = 0;
      }
      await new Promise((r) => setTimeout(r, streamPollMs));
    }
    reply.raw.end();
  });

  // ---- agent registry & runner protocol -----------------------------------

  app.get("/runners", () => store.listRunners());
  // Cost and quota (spec §39).
  app.put("/projects/:id/budget", role("owner"), (req) =>
    store.setBudget(idParams.parse(req.params).id, budget.nullable().parse(req.body ?? null)),
  );
  app.get("/projects/:id/costs", (req) =>
    store.costReport(idParams.parse(req.params).id, z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query).days),
  );
  app.get("/agents/cooldowns", () => store.listCooldowns());
  app.delete("/runners/:id/cooldowns/:agent", role("senior"), async (req, reply) => {
    const { id, agent } = z.object({ id: z.uuid(), agent: z.string().min(1) }).parse(req.params);
    await store.clearCooldown(id, agent, req.actor.name);
    reply.status(204);
  });
  app.get("/agents/stats", (req) => store.agentStats(z.object({ projectId: z.uuid().optional() }).parse(req.query).projectId));

  app.post("/runners/register", role("runner"), async (req, reply) => {
    const { name, agents } = registerRunnerBody.parse(req.body);
    reply.status(201);
    return { runnerId: await store.registerRunner(name, agents) };
  });

  app.post("/runners/:id/claim", role("runner"), async (req, reply) => {
    const claim = await store.claim(idParams.parse(req.params).id);
    return claim ?? reply.status(204).send();
  });

  /** Which of the runner's worktrees belong to finished tasks and can be removed. */
  app.post("/runners/:id/gc", role("runner"), (req) => store.finishedTaskKeys(gcBody.parse(req.body).taskKeys));

  app.get("/executions/:id", (req) => store.getExecution(idParams.parse(req.params).id));
  app.post("/executions/:id/start", role("runner"), (req) => {
    const { workspace, branch } = startExecutionBody.parse(req.body);
    return store.startExecution(idParams.parse(req.params).id, workspace, branch);
  });
  app.post("/executions/:id/heartbeat", role("runner"), (req) => store.heartbeat(idParams.parse(req.params).id));
  app.post("/executions/:id/events", role("runner"), async (req, reply) => {
    const { events } = appendEventsBody.parse(req.body);
    await store.appendAgentEvents(idParams.parse(req.params).id, events as never);
    return reply.status(204).send();
  });
  app.post("/executions/:id/complete", role("runner"), (req) => {
    const body = completeExecutionBody.parse(req.body);
    return store.completeExecution(idParams.parse(req.params).id, body as never);
  });
  app.post("/executions/:id/validation", role("runner"), (req) =>
    store.recordValidation(idParams.parse(req.params).id, validationReportBody.parse(req.body)),
  );
  app.post("/executions/:id/delivery", role("runner"), (req) =>
    store.recordDelivery(idParams.parse(req.params).id, deliveryBody.parse(req.body)),
  );
  app.get("/executions/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ executionId: idParams.parse(req.params).id }, after, limit), after);
  });

  // Called by the agent's PreToolUse hook (execution token, not an API token).
  app.post("/executions/:id/tool-check", PUBLIC, (req) => {
    const token = req.headers[EXECUTION_TOKEN_HEADER];
    return store.checkToolCall(
      idParams.parse(req.params).id,
      typeof token === "string" ? token : undefined,
      toolCheckBody.parse(req.body),
    );
  });

  return app;
}

function page<T extends { seq: number }>(events: T[], after: number) {
  return { events, nextAfter: events.at(-1)?.seq ?? after };
}
