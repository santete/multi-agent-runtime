import { loadConfig } from "./config.js";
import { Runner } from "./runner.js";

const configPath = process.env.RUNNER_CONFIG ?? process.argv[2] ?? "runner.config.json";
const runner = new Runner(await loadConfig(configPath));

process.on("SIGINT", () => runner.stop());
process.on("SIGTERM", () => runner.stop());

await runner.start();
