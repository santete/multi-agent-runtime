import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { availableAgents, loadConfig } from "../src/config.js";

const config = { controlPlaneUrl: "http://127.0.0.1:7700", name: "dev", home: "./.runner", agents: { shell: { adapter: "generic-cli", command: "bash" } } };

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "mar-runner-config-"));
  const initCwd = process.env.INIT_CWD;
  afterEach(() => {
    if (initCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initCwd;
  });

  it("reads the file from where the command was run and makes home relative to it", async () => {
    const launch = join(dir, "launch");
    mkdirSync(launch, { recursive: true });
    // With a byte order mark, as Windows PowerShell 5 writes it.
    writeFileSync(join(launch, "runner.config.json"), String.fromCharCode(0xfeff) + JSON.stringify(config));
    process.env.INIT_CWD = launch;
    const loaded = await loadConfig("runner.config.json");
    expect(loaded.name).toBe("dev");
    expect(loaded.home).toBe(join(launch, ".runner"));
  });

  it("keeps an absolute home", async () => {
    const home = join(dir, "abs-home");
    writeFileSync(join(dir, "abs.json"), JSON.stringify({ ...config, home }));
    expect((await loadConfig(join(dir, "abs.json"))).home).toBe(home);
  });

  it("explains a missing or invalid file in one line", async () => {
    process.env.INIT_CWD = dir;
    await expect(loadConfig("nope.json")).rejects.toThrow(/nope\.json does not exist\. Copy apps\/runner\/runner\.config\.example\.json/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...config, controlPlaneUrl: "not a url" }));
    await expect(loadConfig(join(dir, "bad.json"))).rejects.toThrow(/bad\.json: controlPlaneUrl: /);
    writeFileSync(join(dir, "broken.json"), "{");
    await expect(loadConfig(join(dir, "broken.json"))).rejects.toThrow(/is not valid JSON/);
  });
});

describe("availableAgents", () => {
  it("leaves out agents whose CLI is not on this machine, such as an example path left in", () => {
    const { config: kept, missing } = availableAgents(
      {
        ...config,
        agents: {
          "claude-code": { adapter: "claude-code" },
          qoder: { adapter: "qoder", executable: "C:/Users/<you>/.qoder/bin/qodercli/qodercli.exe" },
          shell: { adapter: "generic-cli", command: "bash" },
        },
      },
      (command) => command === "claude" || command === "bash",
    );
    expect(Object.keys(kept.agents)).toEqual(["claude-code", "shell"]);
    expect(missing).toEqual([{ agent: "qoder", command: "C:/Users/<you>/.qoder/bin/qodercli/qodercli.exe" }]);
  });
});
