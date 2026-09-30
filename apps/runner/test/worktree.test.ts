import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager, git } from "../src/worktree.js";
import { createOriginRepo, tempDir } from "./helpers.js";

let origin: Awaited<ReturnType<typeof tempDir>>;
let home: Awaited<ReturnType<typeof tempDir>>;
let project: { key: string; repoUrl: string; defaultBranch: string };

beforeEach(async () => {
  origin = await tempDir("origin");
  home = await tempDir("home");
  project = { key: "PAY", repoUrl: await createOriginRepo(origin.path), defaultBranch: "main" };
});

afterEach(async () => {
  await home.cleanup();
  await origin.cleanup();
});

describe("WorktreeManager", () => {
  it("creates an isolated worktree on a task branch from the default branch", async () => {
    const manager = new WorktreeManager(home.path);
    const ws = await manager.prepare(project, "PAY-1");
    expect(ws).toEqual({ path: join(home.path, "worktrees", "PAY-1"), branch: "task/PAY-1", created: true });
    expect(existsSync(join(ws.path, "README.md"))).toBe(true);
    expect(await git(ws.path, "branch", "--show-current")).toBe("task/PAY-1");
  });

  it("reuses the worktree of the same task (retry/rework)", async () => {
    const manager = new WorktreeManager(home.path);
    await manager.prepare(project, "PAY-1");
    expect((await manager.prepare(project, "PAY-1")).created).toBe(false);
  });

  it("prepares worktrees for different tasks concurrently without git lock errors", async () => {
    const manager = new WorktreeManager(home.path);
    const results = await Promise.all(["PAY-1", "PAY-2", "PAY-3"].map((k) => manager.prepare(project, k)));
    expect(new Set(results.map((r) => r.branch)).size).toBe(3);
  });

  it("removes a worktree", async () => {
    const manager = new WorktreeManager(home.path);
    const ws = await manager.prepare(project, "PAY-1");
    await manager.remove(project, "PAY-1");
    expect(existsSync(ws.path)).toBe(false);
  });

  it("fails clearly for an unreachable repository", async () => {
    const manager = new WorktreeManager(home.path);
    await expect(manager.prepare({ ...project, repoUrl: join(home.path, "missing") }, "PAY-1")).rejects.toThrow();
  });
});
