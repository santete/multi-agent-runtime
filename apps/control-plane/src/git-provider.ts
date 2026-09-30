import type { PullRequestRef } from "@mar/core";

export interface OpenPullRequest {
  repoUrl: string;
  /** Branch with the changes. */
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MergePullRequest {
  repoUrl: string;
  number: number;
  /** Branch to delete after a successful merge. */
  head: string;
  commitTitle: string;
}

export type MergeResult =
  | { status: "merged"; sha: string | null }
  /** The branch conflicts with the base: the task needs rework. */
  | { status: "conflict"; message: string }
  /** Not decidable yet (e.g. GitHub still computing mergeability): try again later. */
  | { status: "pending"; message: string };

/**
 * Hosting provider the control plane uses to deliver work (ADR-0002: only
 * the platform talks to GitHub; agents never hold credentials).
 */
export interface GitProvider {
  /** Returns null when this provider does not handle the repository. */
  openPullRequest(req: OpenPullRequest): Promise<PullRequestRef | null>;
  /** Idempotent: an already merged pull request reports "merged". */
  mergePullRequest(req: MergePullRequest): Promise<MergeResult>;
}

export class GitProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitProviderError";
  }
}

/** Parses `https://github.com/o/r(.git)` and `git@github.com:o/r(.git)`. */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export class GitHubProvider implements GitProvider {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async openPullRequest(req: OpenPullRequest): Promise<PullRequestRef | null> {
    const repo = parseGitHubRepo(req.repoUrl);
    if (!repo) return null;
    const base = `${this.apiBase}/repos/${repo.owner}/${repo.repo}`;

    const created = await this.call("POST", `${base}/pulls`, {
      title: req.title,
      head: req.head,
      base: req.base,
      body: req.body,
    });
    if (created.status === 201) return toRef(created.body);

    // Re-delivery after rework: the PR for this branch already exists.
    if (created.status === 422) {
      const existing = await this.call(
        "GET",
        `${base}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${req.head}`)}`,
      );
      const [pr] = Array.isArray(existing.body) ? existing.body : [];
      if (pr) return toRef(pr);
    }
    throw new GitProviderError(`GitHub ${created.status}: ${JSON.stringify(created.body).slice(0, 500)}`);
  }

  async mergePullRequest(req: MergePullRequest): Promise<MergeResult> {
    const repo = parseGitHubRepo(req.repoUrl);
    if (!repo) throw new GitProviderError(`not a GitHub repository: ${req.repoUrl}`);
    const base = `${this.apiBase}/repos/${repo.owner}/${repo.repo}`;

    const pr = await this.call("GET", `${base}/pulls/${req.number}`);
    if (pr.status !== 200) throw new GitProviderError(`GitHub ${pr.status} reading PR #${req.number}`);
    if (pr.body.merged) return { status: "merged", sha: pr.body.merge_commit_sha ?? null };
    if (pr.body.state !== "open") throw new GitProviderError(`PR #${req.number} is ${pr.body.state}`);
    if (pr.body.mergeable === false) return { status: "conflict", message: `PR #${req.number} has conflicts with ${pr.body.base?.ref}` };
    if (pr.body.mergeable == null) return { status: "pending", message: "GitHub is still computing mergeability" };

    const merged = await this.call("PUT", `${base}/pulls/${req.number}/merge`, {
      merge_method: "squash",
      commit_title: req.commitTitle,
    });
    if (merged.status === 200) {
      // Best effort: the task branch is no longer needed.
      await this.call("DELETE", `${base}/git/refs/heads/${req.head}`).catch(() => undefined);
      return { status: "merged", sha: merged.body?.sha ?? null };
    }
    // 405: not mergeable (conflict or checks); 409: head changed while merging.
    if (merged.status === 405) return { status: "conflict", message: merged.body?.message ?? "not mergeable" };
    if (merged.status === 409) return { status: "pending", message: merged.body?.message ?? "head changed" };
    throw new GitProviderError(`GitHub ${merged.status}: ${JSON.stringify(merged.body).slice(0, 500)}`);
  }

  private async call(method: string, url: string, body?: object): Promise<{ status: number; body: any }> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

function toRef(pr: { html_url: string; number: number }): PullRequestRef {
  return { url: pr.html_url, number: pr.number };
}
