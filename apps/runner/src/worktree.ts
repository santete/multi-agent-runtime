import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFile } from "@mar/core";

const execFileAsync = promisify(execFile);

async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitRaw(cwd, ...args)).trim();
}

/** Paths changed in the worktree (modified, added, deleted, untracked), excluding git-excluded files. */
export async function changedFiles(worktree: string): Promise<string[]> {
  // Not trimmed: each entry starts with a two-letter status that may begin with a space (" M path").
  const out = await gitRaw(worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const entries = out.split("\0").filter(Boolean);
  const files = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // A path can appear twice (e.g. deleted from the index but present on disk).
    files.add(entry.slice(3));
    // Renames/copies are followed by the original path.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return [...files];
}

export interface CommitOptions {
  branch: string;
  message: string;
  author: { name: string; email: string };
  /** Tracked files the runner modified for its own use; restored before committing. */
  restore: string[];
}

export interface CommitResult {
  commitSha: string | null;
  changedFiles: string[];
}

/**
 * Commits all task changes and pushes the task branch. Done by the runner
 * after validation, never by the agent (ADR-0004). Returns a null sha when
 * there is nothing to commit.
 */
export async function commitAndPush(worktree: string, opts: CommitOptions): Promise<CommitResult> {
  if (opts.restore.length) await git(worktree, "checkout", "--", ...opts.restore);
  const files = await changedFiles(worktree);
  if (!files.length) return { commitSha: null, changedFiles: [] };

  await git(worktree, "add", "-A");
  await git(
    worktree,
    "-c",
    `user.name=${opts.author.name}`,
    "-c",
    `user.email=${opts.author.email}`,
    "commit",
    "-q",
    "--no-verify",
    "-m",
    opts.message,
  );
  const commitSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "origin", `HEAD:refs/heads/${opts.branch}`);
  return { commitSha, changedFiles: files };
}

async function isTracked(worktree: string, path: string): Promise<boolean> {
  try {
    await git(worktree, "ls-files", "--error-unmatch", "--", path);
    return true;
  } catch {
    return false;
  }
}

/** Adds `/path` to the repository's shared info/exclude (worktrees share it). */
async function addExclude(worktree: string, path: string): Promise<void> {
  const commonDir = await git(worktree, "rev-parse", "--git-common-dir");
  const excludeFile = join(isAbsolute(commonDir) ? commonDir : join(worktree, commonDir), "info", "exclude");
  const line = `/${path}`;
  const current = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  await appendFile(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

export interface WorkspaceProject {
  key: string;
  repoUrl: string;
  defaultBranch: string;
}

export interface Workspace {
  path: string;
  branch: string;
  /** False when an existing worktree was reused (retry/rework). */
  created: boolean;
}

/**
 * One clone per project under `<home>/repos/<PROJECT>` and one git worktree
 * per task under `<home>/worktrees/<TASK-KEY>` on branch `task/<TASK-KEY>`.
 */
export class WorktreeManager {
  /** Serializes git operations per repository (git's index lock is per repo). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly home: string) {}

  repoPath(project: WorkspaceProject): string {
    return join(this.home, "repos", project.key);
  }

  worktreePath(taskKey: string): string {
    return join(this.home, "worktrees", taskKey);
  }

  static branchFor(taskKey: string): string {
    return `task/${taskKey}`;
  }

  async prepare(project: WorkspaceProject, taskKey: string): Promise<Workspace> {
    return this.withLock(project.key, async () => {
      const repo = await this.ensureRepo(project);
      const path = this.worktreePath(taskKey);
      const branch = WorktreeManager.branchFor(taskKey);
      if (existsSync(path)) return { path, branch, created: false };

      await mkdir(join(this.home, "worktrees"), { recursive: true });
      await git(repo, "worktree", "add", "-B", branch, path, `origin/${project.defaultBranch}`);
      return { path, branch, created: true };
    });
  }

  /**
   * Writes runner-managed files (e.g. agent hook config) into a worktree.
   * JSON files marked `mergeJson` keep the repository's own top-level keys.
   * Untracked managed files are git-excluded so they never reach a commit;
   * a merge into a tracked file is reported so it can be reverted before
   * committing (M3).
   */
  async writeFiles(worktree: string, files: WorkspaceFile[]): Promise<{ modifiedTracked: string[] }> {
    const modifiedTracked: string[] = [];
    for (const file of files) {
      const full = join(worktree, ...file.path.split("/"));
      let text: string;
      if (typeof file.content === "string") {
        text = file.content;
      } else {
        let content = file.content;
        if (file.mergeJson && existsSync(full)) {
          const existing = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>;
          content = { ...existing, ...file.content };
        }
        text = JSON.stringify(content, null, 2) + "\n";
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text);

      if (await isTracked(worktree, file.path)) {
        modifiedTracked.push(file.path);
      } else {
        await addExclude(worktree, file.path);
      }
    }
    return { modifiedTracked };
  }

  async remove(project: WorkspaceProject, taskKey: string): Promise<void> {
    await this.withLock(project.key, async () => {
      const path = this.worktreePath(taskKey);
      if (existsSync(path)) await git(this.repoPath(project), "worktree", "remove", "--force", path);
    });
  }

  private async ensureRepo(project: WorkspaceProject): Promise<string> {
    const repo = this.repoPath(project);
    if (existsSync(join(repo, ".git"))) {
      await git(repo, "fetch", "--prune", "origin");
    } else {
      await mkdir(join(this.home, "repos"), { recursive: true });
      await git(this.home, "clone", "--no-checkout", project.repoUrl, repo);
    }
    return repo;
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
