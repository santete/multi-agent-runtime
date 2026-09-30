import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidation } from "../src/validator.js";
import { WorktreeManager } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

let origin: Awaited<ReturnType<typeof tempDir>>;
let home: Awaited<ReturnType<typeof tempDir>>;
let worktree: string;

beforeEach(async () => {
  origin = await tempDir("origin");
  home = await tempDir("home");
  await createOriginRepo(origin.path);
  const ws = await new WorktreeManager(home.path).prepare(
    { key: "VAL", repoUrl: origin.path, defaultBranch: "main" },
    "VAL-1",
  );
  worktree = ws.path;
});

afterEach(async () => {
  await home.cleanup();
  await origin.cleanup();
});

const node = (script: string) => `node -e "${script}"`;

describe("runValidation", () => {
  it("runs steps in order in the worktree and reports changed files", async () => {
    await writeFile(join(worktree, "new.txt"), "x");
    const report = await runValidation(worktree, [
      { name: "first", command: node("console.log('one')") },
      { name: "second", command: node("console.log(require('fs').existsSync('new.txt'))") },
    ]);
    expect(report.passed).toBe(true);
    expect(report.steps.map((s) => [s.name, s.passed, s.outputTail])).toEqual([
      ["first", true, "one"],
      ["second", true, "true"],
    ]);
    expect(report.changedFiles).toEqual(["new.txt"]);
  });

  it("stops at the first failing step and keeps its output", async () => {
    const report = await runValidation(worktree, [
      { name: "lint", command: node("console.error('bad style'); process.exit(2)") },
      { name: "test", command: node("console.log('never')") },
    ]);
    expect(report.passed).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ name: "lint", passed: false, exitCode: 2, outputTail: "bad style" });
  });

  it("fails a step that times out", async () => {
    const report = await runValidation(worktree, [
      { name: "hang", command: node("setTimeout(() => {}, 60000)"), timeoutSeconds: 1 },
    ]);
    expect(report.passed).toBe(false);
    expect(report.steps[0]!.outputTail).toContain("timed out after 1s");
  });

  it("does not pass the agent's MAR_* secrets to validation commands", async () => {
    process.env.MAR_EXECUTION_TOKEN = "secret";
    try {
      const report = await runValidation(worktree, [
        { name: "env", command: node("process.exit(process.env.MAR_EXECUTION_TOKEN ? 1 : 0)") },
      ]);
      expect(report.passed).toBe(true);
    } finally {
      delete process.env.MAR_EXECUTION_TOKEN;
    }
  });

  it("passes with no steps configured", async () => {
    expect(await runValidation(worktree, [])).toEqual({ passed: true, steps: [], changedFiles: [] });
  });
});
