import { timingSafeEqual } from "node:crypto";
import { InvalidTransitionError } from "@mar/core";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { ConflictError, NotFoundError, type Store, UnauthorizedError } from "./store.js";

export const EXECUTION_TOKEN_HEADER = "x-mar-execution-token";

export interface AppOptions extends FastifyServerOptions {
  /** When set, every route except /health and tool-check requires `Authorization: Bearer <token>`. */
  apiToken?: string | undefined;
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

const createProjectBody = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,15}$/, "2-16 chars, uppercase letters/digits, starting with a letter"),
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  validation: validationSteps.optional(),
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
  agent: z.string().min(1),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const capabilities = z.object({
  pause: z.enum(["native", "checkpoint", "none"]),
  resume: z.boolean(),
  approval: z.enum(["pre-tool-hook", "static-rules", "none"]),
  structuredOutput: z.boolean(),
  streaming: z.boolean(),
  costReporting: z.boolean(),
});

const registerRunnerBody = z.object({
  name: z.string().min(1),
  agents: z.array(z.object({ id: z.string().min(1), adapter: z.string().min(1), capabilities })),
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
});

const toolCheckBody = z.object({ tool: z.string().min(1), input: z.unknown() });

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Routes that do not use the API token (tool-check has its own execution token). */
const PUBLIC_ROUTES = new Set(["/health", "/executions/:id/tool-check"]);

export function buildApp(store: Store, opts: AppOptions = {}): FastifyInstance {
  const { apiToken, ...fastifyOpts } = opts;
  const app = Fastify(fastifyOpts);

  if (apiToken) {
    const expected = Buffer.from(`Bearer ${apiToken}`);
    app.addHook("onRequest", async (req, reply) => {
      if (PUBLIC_ROUTES.has(req.routeOptions.url ?? "")) return;
      const given = Buffer.from(req.headers.authorization ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return reply.status(401).send({ error: "unauthorized" });
      }
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "not_found", message: err.message });
    if (err instanceof UnauthorizedError) return reply.status(401).send({ error: "unauthorized" });
    if (err instanceof ConflictError || err instanceof InvalidTransitionError) {
      return reply.status(409).send({ error: "conflict", message: err.message });
    }
    if ((err as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: "bad_request" });
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.get("/health", async () => ({ ok: true }));

  // ---- projects & tasks ---------------------------------------------------

  app.post("/projects", async (req, reply) => {
    reply.status(201);
    return store.createProject(createProjectBody.parse(req.body));
  });
  app.get("/projects", () => store.listProjects());
  app.get("/projects/:id", (req) => store.getProject(idParams.parse(req.params).id));
  app.put("/projects/:id/validation", (req) =>
    store.setValidation(idParams.parse(req.params).id, validationSteps.parse(req.body)),
  );

  app.post("/projects/:id/tasks", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = createTaskBody.parse(req.body);
    reply.status(201);
    return store.createTask(id, body);
  });
  app.get("/projects/:id/tasks", (req) => store.listTasks(idParams.parse(req.params).id));
  app.get("/projects/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ projectId: idParams.parse(req.params).id }, after, limit), after);
  });

  app.get("/tasks/:id", (req) => store.getTask(idParams.parse(req.params).id));
  app.post("/tasks/:id/cancel", (req) => store.cancelTask(idParams.parse(req.params).id));
  app.get("/tasks/:id/executions", (req) => store.listExecutions(idParams.parse(req.params).id));
  app.get("/tasks/:id/artifacts", (req) => store.listArtifacts(idParams.parse(req.params).id));
  app.get("/tasks/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ taskId: idParams.parse(req.params).id }, after, limit), after);
  });

  // ---- agent registry & runner protocol -----------------------------------

  app.get("/runners", () => store.listRunners());

  app.post("/runners/register", async (req, reply) => {
    const { name, agents } = registerRunnerBody.parse(req.body);
    reply.status(201);
    return { runnerId: await store.registerRunner(name, agents) };
  });

  app.post("/runners/:id/claim", async (req, reply) => {
    const claim = await store.claim(idParams.parse(req.params).id);
    return claim ?? reply.status(204).send();
  });

  app.get("/executions/:id", (req) => store.getExecution(idParams.parse(req.params).id));
  app.post("/executions/:id/start", (req) => {
    const { workspace, branch } = startExecutionBody.parse(req.body);
    return store.startExecution(idParams.parse(req.params).id, workspace, branch);
  });
  app.post("/executions/:id/heartbeat", (req) => store.heartbeat(idParams.parse(req.params).id));
  app.post("/executions/:id/events", async (req, reply) => {
    const { events } = appendEventsBody.parse(req.body);
    await store.appendAgentEvents(idParams.parse(req.params).id, events as never);
    return reply.status(204).send();
  });
  app.post("/executions/:id/complete", (req) => {
    const body = completeExecutionBody.parse(req.body);
    return store.completeExecution(idParams.parse(req.params).id, body as never);
  });
  app.post("/executions/:id/validation", (req) =>
    store.recordValidation(idParams.parse(req.params).id, validationReportBody.parse(req.body)),
  );
  app.post("/executions/:id/delivery", (req) =>
    store.recordDelivery(idParams.parse(req.params).id, deliveryBody.parse(req.body)),
  );
  app.get("/executions/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ executionId: idParams.parse(req.params).id }, after, limit), after);
  });

  // Called by the agent's PreToolUse hook (execution token, not the API token).
  app.post("/executions/:id/tool-check", (req) => {
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
