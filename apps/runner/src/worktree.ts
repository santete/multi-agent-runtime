import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

async function revParse(worktree: string, ref: string): Promise<string | null> {
  try {
    return await git(worktree, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return null;
  }
}

const authorArgs = (author: { name: string; email: string }) => [
  "-c",
  `user.name=${author.name}`,
  "-c",
  `user.email=${author.email}`,
];

/**
 * Commits all task changes (concluding a merge of the base branch, if one is
 * in progress) and pushes the task branch when it differs from the remote.
 * Done by the runner after validation, never by the agent (ADR-0004).
 * Returns a null sha when there is nothing to push.
 */
export async function commitAndPush(worktree: string, opts: CommitOptions): Promise<CommitResult> {
  if (opts.restore.length) await git(worktree, "checkout", "--", ...opts.restore);
  const files = await changedFiles(worktree);
  if (files.length || (await isMerging(worktree))) {
    await git(worktree, "add", "-A");
    await git(worktree, ...authorArgs(opts.author), "commit", "-q", "--no-verify", "-m", opts.message);
  }
  const head = await revParse(worktree, "HEAD");
  const remote = await revParse(worktree, `refs/remotes/origin/${opts.branch}`);
  const base = await revParse(worktree, "refs/remotes/origin/HEAD");
  if (!head || head === remote || (!remote && head === base)) return { commitSha: null, changedFiles: files };
  await git(worktree, "push", "origin", `HEAD:refs/heads/${opts.branch}`);
  await git(worktree, "fetch", "-q", "origin", `refs/heads/${opts.branch}:refs/remotes/origin/${opts.branch}`);
  return { commitSha: head, changedFiles: files };
}

async function isMerging(worktree: string): Promise<boolean> {
  return (await revParse(worktree, "MERGE_HEAD")) !== null;
}

/** Files left with unresolved conflicts by a merge. */
export async function conflictedFiles(worktree: string): Promise<string[]> {
  const out = await git(worktree, "diff", "--name-only", "--diff-filter=U");
  return out.split(/\r?\n/).filter(Boolean);
}

/**
 * Merges the latest base branch into the task branch (rework after a merge
 * conflict). Conflicts are left in the worktree for the agent to resolve.
 */
export async function mergeBase(
  worktree: string,
  baseBranch: string,
  author: { name: string; email: string },
): Promise<{ conflicts: string[] }> {
  await git(worktree, "fetch", "-q", "origin");
  try {
    await git(worktree, ...authorArgs(author), "merge", "--no-edit", "--no-verify", `origin/${baseBranch}`);
    return { conflicts: [] };
  } catch {
    const conflicts = await conflictedFiles(worktree);
    if (!conflicts.length) throw new Error(`merging origin/${baseBranch} failed without conflicts`);
    return { conflicts };
  }
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
    return resolve(this.home, "repos", project.key);
  }

  worktreePath(taskKey: string): string {
    return join(this.home, "worktrees", taskKey);
  }

  static branchFor(taskKey: string): string {
    return `task/${taskKey}`;
  }

  /**
   * @param from Remote branch to start from instead (review tasks check out the
   *   reviewed task's branch). An existing worktree is moved to its latest state.
   */
  async prepare(project: WorkspaceProject, taskKey: string, from?: string): Promise<Workspace> {
    return this.withLock(this.repoPath(project), async () => {
      const repo = await this.ensureRepo(project);
      const path = this.worktreePath(taskKey);
      const branch = WorktreeManager.branchFor(taskKey);
      if (existsSync(path)) {
        if (from) await git(path, "reset", "-q", "--hard", `origin/${from}`);
        return { path, branch, created: false };
      }

      await mkdir(join(this.home, "worktrees"), { recursive: true });
      // Continue from the pushed task branch if an earlier attempt (maybe on
      // another machine) delivered it; otherwise start from the base branch.
      const remoteBranch = `origin/${branch}`;
      const start = from
        ? `origin/${from}`
        : (await revParse(repo, `refs/remotes/${remoteBranch}`))
          ? remoteBranch
          : `origin/${project.defaultBranch}`;
      await git(repo, "worktree", "add", "-B", branch, path, start);
      return { path, branch, created: true };
    });
  }

  /** The change a review is about: base...HEAD, capped to keep the context small. */
  async diffAgainst(worktree: string, baseBranch: string, maxBytes = 150_000): Promise<string> {
    const diff = await gitRaw(worktree, "diff", "--no-color", `origin/${baseBranch}...HEAD`);
    return diff.length > maxBytes ? `${diff.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes]\n` : diff;
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

  /** Task keys that currently have a worktree on this machine. */
  async listTaskKeys(): Promise<string[]> {
    const dir = join(this.home, "worktrees");
    if (!existsSync(dir)) return [];
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  }

  /**
   * Removes a finished task's worktree and its local branch. The owning
   * repository is found from the worktree itself.
   */
  async removeByTaskKey(taskKey: string): Promise<void> {
    const path = this.worktreePath(taskKey);
    if (!existsSync(path)) return;
    const commonDir = await git(path, "rev-parse", "--git-common-dir");
    // resolve() normalizes separators so the lock key matches repoPath().
    const repo = resolve(dirname(isAbsolute(commonDir) ? commonDir : join(path, commonDir)));
    await this.withLock(repo, async () => {
      await git(repo, "worktree", "remove", "--force", path);
      await git(repo, "branch", "-D", WorktreeManager.branchFor(taskKey)).catch(() => undefined);
    });
  }

  async remove(project: WorkspaceProject, taskKey: string): Promise<void> {
    await this.withLock(this.repoPath(project), async () => {
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
