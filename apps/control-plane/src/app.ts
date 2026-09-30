import { InvalidTransitionError } from "@mar/core";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { ConflictError, NotFoundError, type Store } from "./store.js";

const idParams = z.object({ id: z.uuid() });

const createProjectBody = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,15}$/, "2-16 chars, uppercase letters/digits, starting with a letter"),
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
});

const createTaskBody = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  agent: z.string().min(1),
});

const registerRunnerBody = z.object({
  name: z.string().min(1),
  agents: z.array(z.string().min(1)),
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

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function buildApp(store: Store, opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(opts);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "not_found", message: err.message });
    if (err instanceof ConflictError || err instanceof InvalidTransitionError) {
      return reply.status(409).send({ error: "conflict", message: err.message });
    }
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
  app.get("/tasks/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ taskId: idParams.parse(req.params).id }, after, limit), after);
  });

  // ---- runner protocol ----------------------------------------------------

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
  app.post("/executions/:id/events", async (req, reply) => {
    const { events } = appendEventsBody.parse(req.body);
    await store.appendAgentEvents(idParams.parse(req.params).id, events as never);
    return reply.status(204).send();
  });
  app.post("/executions/:id/complete", (req) => {
    const body = completeExecutionBody.parse(req.body);
    return store.completeExecution(idParams.parse(req.params).id, body as never);
  });
  app.get("/executions/:id/events", async (req) => {
    const { after, limit } = eventsQuery.parse(req.query);
    return page(await store.listEvents({ executionId: idParams.parse(req.params).id }, after, limit), after);
  });

  return app;
}

function page<T extends { seq: number }>(events: T[], after: number) {
  return { events, nextAfter: events.at(-1)?.seq ?? after };
}
