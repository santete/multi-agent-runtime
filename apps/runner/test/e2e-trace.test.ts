import { buildApp, createPgliteDb, type Db, migrate, Store } from "@mar/control-plane";
import type { ProjectDto, TaskDto } from "@mar/core";
import { initTelemetry, type Telemetry } from "@mar/telemetry";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { createOriginRepo, tempDir } from "./helpers.js";

const WORKER = `require("fs").writeFileSync("a.txt", "ok\\n");`;

describe("one trace per execution", () => {
  const exporter = new InMemorySpanExporter();
  let telemetry: Telemetry;
  let db: Db;
  let app: FastifyInstance;
  let baseUrl: string;
  let origin: Awaited<ReturnType<typeof tempDir>>;
  let home: Awaited<ReturnType<typeof tempDir>>;

  beforeAll(async () => {
    telemetry = initTelemetry({ serviceName: "test", env: {}, spanExporter: exporter });
    db = await createPgliteDb();
    await migrate(db);
    app = buildApp(new Store(db));
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    origin = await tempDir("origin");
    home = await tempDir("home");
    await createOriginRepo(origin.path);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await telemetry.shutdown();
    await Promise.all([home.cleanup(), origin.cleanup()]);
  });

  const api = async <T>(path: string, body?: object): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return (await res.json()) as T;
  };

  it("traces workspace, agent, validation and delivery, with the control plane's spans in the same trace", async () => {
    const project = await api<ProjectDto>("/projects", {
      key: "TR",
      name: "trace",
      repoUrl: origin.path,
      validation: [{ name: "has-file", command: `node -e "require('fs').accessSync('a.txt')"` }],
    });
    const task = await api<TaskDto>(`/projects/${project.id}/tasks`, { title: "a", objective: "write a.txt", agent: "worker" });
    const runner = new Runner(
      {
        controlPlaneUrl: baseUrl,
        name: "trace-box",
        home: home.path,
        heartbeatIntervalMs: 200,
        agents: { worker: { adapter: "generic-cli", command: process.execPath, args: ["-e", WORKER] } },
      },
      { info: () => undefined, error: () => undefined },
    );
    await runner.register();
    expect(await runner.runOnce()).toBe(true);
    expect((await api<TaskDto>(`/tasks/${task.id}`)).state).toBe("REVIEW");

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "execution TR-1")!;
    expect(root.attributes).toMatchObject({
      "mar.task.key": "TR-1",
      "mar.agent": "worker",
      "mar.execution.attempt": 1,
      "mar.execution.outcome": "delivered",
    });
    const trace = spans.filter((s) => s.spanContext().traceId === root.spanContext().traceId);
    const childrenOf = (parent: ReadableSpan) =>
      trace.filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId).map((s) => s.name);

    expect(childrenOf(root)).toEqual(
      expect.arrayContaining(["workspace.prepare", "agent.run", "validation", "delivery", "POST /executions/:id/start", "POST /executions/:id/complete", "POST /executions/:id/validation"]),
    );
    expect(childrenOf(trace.find((s) => s.name === "validation")!)).toEqual(["validation.step has-file"]);
    expect(childrenOf(trace.find((s) => s.name === "delivery")!)).toContain("POST /executions/:id/delivery");
    expect(trace.find((s) => s.name === "agent.run")!.attributes).toMatchObject({ "mar.agent": "worker", "mar.agent.result": "completed" });
    // The claim happens before the execution exists: it is its own request trace.
    expect(spans.some((s) => s.name === "POST /runners/:id/claim" && s.spanContext().traceId !== root.spanContext().traceId)).toBe(true);
  });
});
