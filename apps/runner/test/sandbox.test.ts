import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { containerArgs, runValidation } from "../src/validator.js";
import { tempDir } from "./helpers.js";

const IMAGE = "node:22-alpine";
/** Docker can actually start a container from the image (a daemon can be up yet unable to). */
function dockerReady(): boolean {
  const run = (args: string[], timeout?: number) => spawnSync("docker", args, { stdio: "ignore", windowsHide: true, timeout });
  if (run(["image", "inspect", IMAGE], 20_000).status !== 0) return false;
  const name = `mar-probe-${process.pid}`;
  const ok = run(["run", "--rm", "--name", name, IMAGE, "true"], 20_000).status === 0;
  if (!ok) run(["rm", "-f", name], 20_000);
  return ok;
}

/** runValidation looks for merge conflicts: the directory must be a git repository. */
const gitInit = (path: string) => spawnSync("git", ["init", "-q", path], { stdio: "ignore", windowsHide: true });

describe("container arguments", () => {
  it("isolates the step: no network, no capabilities, worktree at /workspace", () => {
    const args = containerArgs({ name: "test", command: "npm test" }, "C:\\w\\PAY-1", { image: IMAGE, memory: "1g", cpus: 2 }, "mar-x");
    expect(args.slice(0, 10)).toEqual(["run", "--rm", "--name", "mar-x", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]);
    expect(args).toEqual(expect.arrayContaining(["--memory", "1g", "--cpus", "2", "-v", "C:\\w\\PAY-1:/workspace", "-w", "/workspace"]));
    expect(args.slice(-4)).toEqual([IMAGE, "sh", "-c", "npm test"]);
    expect(containerArgs({ name: "t", command: "x" }, "/w", { image: IMAGE, network: true }, "n")).toContain("bridge");
  });

  it("passes secrets by name only: the value comes from the CLI's environment, not the command line", () => {
    const args = containerArgs({ name: "t", command: "x" }, "/w", { image: IMAGE }, "n", ["DB_URL"]);
    expect(args).toEqual(expect.arrayContaining(["-e", "DB_URL"]));
    expect(args.join(" ")).not.toContain("DB_URL=");
  });
});

describe.skipIf(!dockerReady())("validation in a container (docker)", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeAll(async () => {
    dir = await tempDir("sandbox");
    gitInit(dir.path);
    await writeFile(join(dir.path, "a.txt"), "ok\n");
  });
  afterAll(() => dir.cleanup());

  it("runs the steps on the mounted worktree without network access", async () => {
    const report = await runValidation(
      dir.path,
      [
        { name: "sees the worktree", command: "test -f a.txt && node --version" },
        // Passes only if the request fails.
        { name: "no network", command: `node -e "fetch('https://example.com').then(() => process.exit(1), () => process.exit(0))"` },
        { name: "writes", command: "echo built > out.txt" },
      ],
      undefined,
      { sandbox: { image: IMAGE } },
    );
    expect(report.steps.map((s) => [s.name, s.passed])).toEqual([
      ["sees the worktree", true],
      ["no network", true],
      ["writes", true],
    ]);
    expect(report.steps[0]!.outputTail).toMatch(/^v22\./m);
    expect(report.passed).toBe(true);
  }, 120_000);

  it("reports a failing step with its output", async () => {
    const report = await runValidation(dir.path, [{ name: "fails", command: "echo boom >&2; exit 3" }], undefined, { sandbox: { image: IMAGE } });
    expect(report.steps[0]).toMatchObject({ passed: false, exitCode: 3, outputTail: expect.stringContaining("boom") });
  }, 120_000);

  it("gives the project's validation secrets to the container (spec §48)", async () => {
    const report = await runValidation(dir.path, [{ name: "secret", command: 'test "$DB_URL" = "pg://in-container"' }], undefined, {
      sandbox: { image: IMAGE },
      env: { DB_URL: "pg://in-container" },
    });
    expect(report.passed).toBe(true);
  }, 120_000);
});

describe("validation without a container runtime", () => {
  it("fails closed instead of running on the host", async () => {
    const dir = await tempDir("sandbox-missing");
    gitInit(dir.path);
    try {
      const report = await runValidation(dir.path, [{ name: "test", command: "exit 0" }], undefined, {
        sandbox: { image: IMAGE },
        containerRuntime: "no-such-container-runtime",
      });
      expect(report.passed).toBe(false);
      expect(report.steps[0]!.outputTail).toMatch(/failed to start/);
    } finally {
      await dir.cleanup();
    }
  });
});
