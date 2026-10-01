import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeTraceparent,
  extractTraceContext,
  initTelemetry,
  injectTraceHeaders,
  SpanKind,
  type Telemetry,
  withSpan,
} from "../src/index.js";

describe("telemetry off", () => {
  it("is a no-op without an OTLP endpoint", async () => {
    const t = initTelemetry({ serviceName: "x", env: {} });
    expect(t.enabled).toBe(false);
    // Spans still run the code, they are just not recorded.
    expect(await withSpan("s", {}, async () => 42)).toBe(42);
    expect(activeTraceparent()).toBeUndefined();
    expect(initTelemetry({ serviceName: "x", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_SDK_DISABLED: "true" } }).enabled).toBe(false);
  });
});

describe("telemetry on", () => {
  const exporter = new InMemorySpanExporter();
  let telemetry: Telemetry;
  beforeAll(() => {
    telemetry = initTelemetry({ serviceName: "test", env: {}, spanExporter: exporter });
  });
  afterAll(() => telemetry.shutdown());

  it("nests spans and records failures", async () => {
    exporter.reset();
    await withSpan("parent", { a: 1 }, async () => {
      await withSpan("child", {}, async () => undefined);
      await expect(withSpan("broken", {}, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
    const spans = exporter.getFinishedSpans();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.child!.parentSpanContext?.spanId).toBe(byName.parent!.spanContext().spanId);
    expect(byName.broken!.status).toMatchObject({ code: 2, message: "Error: boom" });
    expect(byName.parent!.attributes).toEqual({ a: 1 });
    expect(byName.parent!.resource.attributes["service.name"]).toBe("test");
  });

  it("carries the trace across processes with traceparent", async () => {
    exporter.reset();
    let headers: Record<string, string> = {};
    let traceparent: string | undefined;
    await withSpan("runner", {}, async () => {
      headers = injectTraceHeaders({});
      traceparent = activeTraceparent();
    });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceparent).toBe(headers.traceparent);

    // The receiving side continues the same trace.
    await withSpan("control plane", {}, async () => undefined, { parent: extractTraceContext(headers), kind: SpanKind.SERVER });
    const [runner, server] = [exporter.getFinishedSpans().find((s) => s.name === "runner")!, exporter.getFinishedSpans().find((s) => s.name === "control plane")!];
    expect(server.spanContext().traceId).toBe(runner.spanContext().traceId);
    expect(server.parentSpanContext?.spanId).toBe(runner.spanContext().spanId);
  });

  it("starts a new trace for a root span", async () => {
    exporter.reset();
    await withSpan("outer", {}, () => withSpan("fresh", {}, async () => undefined, { root: true }));
    const [fresh, outer] = [exporter.getFinishedSpans().find((s) => s.name === "fresh")!, exporter.getFinishedSpans().find((s) => s.name === "outer")!];
    expect(fresh.spanContext().traceId).not.toBe(outer.spanContext().traceId);
    expect(fresh.parentSpanContext).toBeUndefined();
  });
});
