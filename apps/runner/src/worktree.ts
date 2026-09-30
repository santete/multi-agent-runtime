import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFile } from "@mar/core";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
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
      let content = file.content;
      if (file.mergeJson && existsSync(full)) {
        const existing = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>;
        content = { ...existing, ...file.content };
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, JSON.stringify(content, null, 2) + "\n");

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
