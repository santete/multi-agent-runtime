/**
 * OpenTelemetry for the platform (spec §41): traces and metrics exported over
 * OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; a no-op otherwise.
 *
 * One trace per execution (task attempt): the runner starts it, and the
 * control plane's request spans and the agent's policy checks join it
 * through W3C trace context (the `traceparent` header / TRACEPARENT env).
 */
import {
  type Attributes,
  type Context,
  context,
  type Meter,
  metrics,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, type MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

export { SpanKind, SpanStatusCode, type Attributes, type Context, type Span };

export interface TelemetryOptions {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  /** Export spans here instead of OTLP (tests). */
  spanExporter?: SpanExporter;
  /** Read metrics here instead of exporting them over OTLP (tests). */
  metricReader?: MetricReader;
}

export interface Telemetry {
  enabled: boolean;
  /** Flushes and stops exporting. */
  shutdown(): Promise<void>;
}

const NAME = "multi-agent-runtime";

/**
 * Starts tracing and metrics for this process. Standard OTEL_* variables
 * apply (endpoint, headers, OTEL_SERVICE_NAME, OTEL_SDK_DISABLED).
 */
export function initTelemetry(options: TelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (env.OTEL_SDK_DISABLED === "true" || (!endpoint && !options.spanExporter)) {
    return { enabled: false, shutdown: async () => undefined };
  }
  const resource = resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME || options.serviceName,
    "service.namespace": NAME,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [options.spanExporter ? new SimpleSpanProcessor(options.spanExporter) : new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  const reader =
    options.metricReader ??
    (endpoint ? new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }) : undefined);
  const meterProvider = reader ? new MeterProvider({ resource, readers: [reader] }) : undefined;

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  if (meterProvider) metrics.setGlobalMeterProvider(meterProvider);

  return {
    enabled: true,
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider?.shutdown();
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
    },
  };
}

export function meter(): Meter {
  return metrics.getMeter(NAME);
}

/**
 * Runs `fn` in a new span (a child of the active one, or of `parent`),
 * recording exceptions and ending the span when `fn` settles.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { parent?: Context; kind?: SpanKind; root?: boolean } = {},
): Promise<T> {
  const parent = options.root ? ROOT_CONTEXT : (options.parent ?? context.active());
  return trace.getTracer(NAME).startActiveSpan(name, { attributes, kind: options.kind ?? SpanKind.INTERNAL }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Starts a span that the caller ends (e.g. across request hooks). */
export function startSpan(name: string, attributes: Attributes, parent: Context, kind = SpanKind.INTERNAL): Span {
  return trace.getTracer(NAME).startSpan(name, { attributes, kind }, parent);
}

export function contextWithSpan(span: Span, parent: Context = context.active()): Context {
  return trace.setSpan(parent, span);
}

export function runInContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}

/** Adds the active trace context (traceparent) to outgoing HTTP headers. */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/** The trace context sent by the caller, to parent a server span. */
export function extractTraceContext(headers: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, headers);
}

/** The active trace context as a TRACEPARENT value for a child process, if any. */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Sets attributes on the active span, if there is one. */
export function setActiveAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
