import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager, changedFiles, git } from "../src/worktree.js";
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

describe("changedFiles", () => {
  it("lists modified, deleted, renamed and untracked files with their full paths", async () => {
    await mkdir(join(origin.path, "src"));
    await writeFile(join(origin.path, "src", "payments.js"), "a\n");
    await writeFile(join(origin.path, "old.txt"), "o\n");
    await git(origin.path, "add", ".");
    await git(origin.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "files");

    const ws = await new WorktreeManager(home.path).prepare(project, "PAY-9");
    await writeFile(join(ws.path, "src", "payments.js"), "b\n"); // " M" — leading space in porcelain output
    await git(ws.path, "mv", "old.txt", "renamed.txt");
    await writeFile(join(ws.path, "README.md"), "changed\n");
    await git(ws.path, "rm", "-q", "README.md", "--cached");
    await writeFile(join(ws.path, "new.txt"), "n\n");

    expect((await changedFiles(ws.path)).sort()).toEqual(["README.md", "new.txt", "renamed.txt", "src/payments.js"]);
  });
});

describe("WorktreeManager.writeFiles", () => {
  const hookFile = (content: object) => ({ path: ".agents/hooks.json", mergeJson: true, content });

  it("writes untracked managed files and keeps them out of git", async () => {
    const manager = new WorktreeManager(home.path);
    const ws = await manager.prepare(project, "PAY-1");
    const result = await manager.writeFiles(ws.path, [hookFile({ "mar-policy": { PreToolUse: [] } })]);
    expect(result.modifiedTracked).toEqual([]);
    expect(JSON.parse(readFileSync(join(ws.path, ".agents", "hooks.json"), "utf8"))).toEqual({
      "mar-policy": { PreToolUse: [] },
    });
    expect(await git(ws.path, "status", "--porcelain")).toBe("");
    // idempotent: the exclude line is not duplicated
    await manager.writeFiles(ws.path, [hookFile({ "mar-policy": {} })]);
    const exclude = await git(ws.path, "rev-parse", "--git-common-dir");
    const lines = readFileSync(join(resolve(ws.path, exclude), "info", "exclude"), "utf8").split(/\r?\n/);
    expect(lines.filter((l) => l === "/.agents/hooks.json")).toHaveLength(1);
  });

  it("merges into a tracked JSON file and reports it", async () => {
    await mkdir(join(origin.path, ".agents"));
    await writeFile(join(origin.path, ".agents", "hooks.json"), JSON.stringify({ "repo-lint": { PostToolUse: [] } }));
    await git(origin.path, "add", ".");
    await git(origin.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "hooks");

    const manager = new WorktreeManager(home.path);
    const ws = await manager.prepare(project, "PAY-2");
    const result = await manager.writeFiles(ws.path, [hookFile({ "mar-policy": { PreToolUse: [] } })]);
    expect(result.modifiedTracked).toEqual([".agents/hooks.json"]);
    expect(Object.keys(JSON.parse(readFileSync(join(ws.path, ".agents", "hooks.json"), "utf8")))).toEqual([
      "repo-lint",
      "mar-policy",
    ]);
  });
});

describe("self-healing workspaces", () => {
  it("detects a broken worktree and recreates it from scratch", async () => {
    const manager = new WorktreeManager(home.path);
    const ws = await manager.prepare(project, "PAY-1");
    // e.g. an interrupted cleanup left the directory but not its git link
    await rm(join(ws.path, ".git"), { force: true });
    await writeFile(join(ws.path, ".git"), "gitdir: /nowhere\n");
    await expect(manager.prepare(project, "PAY-1")).rejects.toThrow(/is broken/);

    await manager.discard(project, "PAY-1");
    const fresh = await manager.prepare(project, "PAY-1");
    expect(fresh.created).toBe(true);
    expect(await git(fresh.path, "branch", "--show-current")).toBe("task/PAY-1");
  });

  it("can throw away the clone too", async () => {
    const manager = new WorktreeManager(home.path);
    await manager.prepare(project, "PAY-1");
    await writeFile(join(manager.repoPath(project), ".git", "HEAD"), "garbage\n");
    await manager.discard(project, "PAY-1", true);
    expect(existsSync(manager.repoPath(project))).toBe(false);
    expect((await manager.prepare(project, "PAY-1")).created).toBe(true);
  });
});
