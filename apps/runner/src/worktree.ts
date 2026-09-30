import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
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
