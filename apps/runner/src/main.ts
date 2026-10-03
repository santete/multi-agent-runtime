import { initTelemetry } from "@mar/telemetry";
import { loadConfig } from "./config.js";
import { Runner } from "./runner.js";

const configPath = process.env.RUNNER_CONFIG ?? process.argv[2] ?? "runner.config.json";
// Traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const telemetry = initTelemetry({ serviceName: "mar-runner" });
const runner = new Runner(
  await loadConfig(configPath).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }),
);

const stop = () => {
  runner.stop();
  // Flush what the last executions recorded.
  void telemetry.shutdown();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await runner.start();
