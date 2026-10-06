import { initTelemetry } from "@mar/telemetry";
import { availableAgents, loadConfig } from "./config.js";
import { commandExists } from "./resolve.js";
import { Runner } from "./runner.js";

const configPath = process.env.RUNNER_CONFIG ?? process.argv[2] ?? "runner.config.json";
// Traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const telemetry = initTelemetry({ serviceName: "mar-runner" });
const loaded = await loadConfig(configPath).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
const { config, missing } = availableAgents(loaded, (command) => commandExists(command));
for (const m of missing) {
  console.error(`agent "${m.agent}" is not offered: its command ${m.command} was not found on this machine (install it, or fix "executable" in the config)`);
}
if (!Object.keys(config.agents).length) {
  console.error("no agent of the config can run on this machine; nothing to offer");
  process.exit(1);
}
const runner = new Runner(config);

const stop = () => {
  runner.stop();
  // Flush what the last executions recorded.
  void telemetry.shutdown();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await runner.start();
