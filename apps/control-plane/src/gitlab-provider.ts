import type { CheckRun, ChecksState, PullRequestRef } from "@mar/core";
import { SpanKind, withSpan } from "@mar/telemetry";
import {
  checksState,
  type GitProvider,
  GitProviderError,
  type MergePullRequest,
  type MergeResult,
  type OpenPullRequest,
  type PullRequestStatus,
} from "./git-provider.js";

/**
 * GitLab (gitlab.com or self-hosted) through its REST API v4: merge requests
 * play the part of pull requests, `iid` their number.
 */
export class GitLabProvider implements GitProvider {
  private readonly host: string;

  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://gitlab.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.host = new URL(this.baseUrl).host.toLowerCase();
  }

  /** The project path (group/subgroup/repo) of a repository on this GitLab, or null. */
  projectPath(url: string): string | null {
    const u = url.trim();
    const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(u);
    const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/i.exec(u);
    const m = https ?? ssh;
    if (!m || m[1]!.toLowerCase().replace(/:\d+$/, "") !== this.host.replace(/:\d+$/, "")) return null;
    return m[2]!.includes("/") ? m[2]! : null;
  }

  handles(repoUrl: string): boolean {
    return this.projectPath(repoUrl) !== null;
  }

  async openPullRequest(req: OpenPullRequest): Promise<PullRequestRef | null> {
    const project = this.projectPath(req.repoUrl);
    if (!project) return null;
    const created = await this.call("POST", `${this.api(project)}/merge_requests`, {
      source_branch: req.head,
      target_branch: req.base,
      title: req.title,
      description: req.body,
      remove_source_branch: true,
      squash: true,
    });
    if (created.status === 201) return toRef(created.body);
    // Re-delivery after rework: the merge request for this branch already exists.
    if (created.status === 409) {
      const existing = await this.call(
        "GET",
        `${this.api(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(req.head)}`,
      );
      const [mr] = Array.isArray(existing.body) ? existing.body : [];
      if (mr) return toRef(mr);
    }
    throw new GitProviderError(`GitLab ${created.status}: ${JSON.stringify(created.body).slice(0, 500)}`);
  }

  async mergePullRequest(req: MergePullRequest): Promise<MergeResult> {
    const project = this.required(req.repoUrl);
    const mr = await this.mergeRequest(project, req.number);
    if (mr.state === "merged") return { status: "merged", sha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? null };
    if (mr.state !== "opened") throw new GitProviderError(`merge request !${req.number} is ${mr.state}`);
    if (mr.has_conflicts) return { status: "conflict", message: `merge request !${req.number} has conflicts with ${mr.target_branch}` };
    const detailed: string = mr.detailed_merge_status ?? mr.merge_status ?? "";
    if (["checking", "unchecked", "preparing", "approvals_syncing", "cannot_be_merged_recheck"].includes(detailed)) {
      return { status: "pending", message: `GitLab is still checking mergeability (${detailed})` };
    }

    const merged = await this.call("PUT", `${this.api(project)}/merge_requests/${req.number}/merge`, {
      squash: true,
      squash_commit_message: req.commitTitle,
      should_remove_source_branch: true,
    });
    if (merged.status === 200) return { status: "merged", sha: merged.body?.merge_commit_sha ?? merged.body?.squash_commit_sha ?? null };
    // 406: conflicts; 405: not mergeable yet (pipeline, draft, discussions); 409: head changed (sha mismatch).
    if (merged.status === 406) return { status: "conflict", message: merged.body?.message ?? "branch cannot be merged" };
    if (merged.status === 405 || merged.status === 409 || merged.status === 422) {
      return { status: "pending", message: merged.body?.message ?? `GitLab ${merged.status}` };
    }
    throw new GitProviderError(`GitLab ${merged.status}: ${JSON.stringify(merged.body).slice(0, 500)}`);
  }

  async commentOnPullRequest(req: { repoUrl: string; number: number; body: string }): Promise<void> {
    const project = this.projectPath(req.repoUrl);
    if (!project) return;
    const res = await this.call("POST", `${this.api(project)}/merge_requests/${req.number}/notes`, { body: req.body });
    if (res.status !== 201) throw new GitProviderError(`GitLab ${res.status} commenting on merge request !${req.number}`);
  }

  async pullRequestStatus(req: { repoUrl: string; number: number }): Promise<PullRequestStatus> {
    const project = this.required(req.repoUrl);
    const mr = await this.mergeRequest(project, req.number);
    const headSha: string = mr.sha;
    // Commits on the target branch that the merge request's head does not contain.
    const [compare, checks] = await Promise.all([
      this.call("GET", `${this.api(project)}/repository/compare?from=${headSha}&to=${encodeURIComponent(mr.target_branch)}`),
      this.statusesOf(project, headSha),
    ]);
    if (compare.status !== 200) throw new GitProviderError(`GitLab ${compare.status} comparing !${req.number} with its target`);
    return { headSha, behindBase: (compare.body?.commits ?? []).length > 0, checks };
  }

  commitChecks(req: { repoUrl: string; sha: string }): Promise<{ state: ChecksState; runs: CheckRun[] }> {
    return this.statusesOf(this.required(req.repoUrl), req.sha);
  }

  /**
   * GitLab has no "revert merge request" API: a branch from the target, the
   * merged commit reverted onto it, and a merge request from that branch.
   */
  async revertPullRequest(req: { repoUrl: string; number: number; title: string; body: string }): Promise<PullRequestRef> {
    const project = this.required(req.repoUrl);
    const mr = await this.mergeRequest(project, req.number);
    const sha: string | null = mr.squash_commit_sha ?? mr.merge_commit_sha ?? null;
    if (mr.state !== "merged" || !sha) throw new GitProviderError(`merge request !${req.number} is not merged`);
    const branch = `revert-mr-${req.number}`;
    const created = await this.call("POST", `${this.api(project)}/repository/branches`, { branch, ref: mr.target_branch });
    if (created.status !== 201) throw new GitProviderError(`GitLab ${created.status} creating ${branch}`);
    const reverted = await this.call("POST", `${this.api(project)}/repository/commits/${sha}/revert`, { branch });
    if (reverted.status !== 201) throw new GitProviderError(`GitLab could not revert ${sha}: ${JSON.stringify(reverted.body).slice(0, 300)}`);
    const opened = await this.openPullRequest({ repoUrl: req.repoUrl, head: branch, base: mr.target_branch, title: req.title, body: req.body });
    return opened!;
  }

  /** Commit statuses: GitLab CI jobs and external CI alike. */
  private async statusesOf(project: string, sha: string): Promise<{ state: ChecksState; runs: CheckRun[] }> {
    const res = await this.call("GET", `${this.api(project)}/repository/commits/${sha}/statuses?per_page=100`);
    if (res.status !== 200) throw new GitProviderError(`GitLab ${res.status} reading the statuses of ${sha}`);
    // The latest status per name (retried jobs report again).
    const latest = new Map<string, any>();
    for (const s of Array.isArray(res.body) ? res.body : []) {
      const seen = latest.get(s.name);
      if (!seen || (s.id ?? 0) > (seen.id ?? 0)) latest.set(s.name, s);
    }
    const runs: CheckRun[] = [...latest.values()].map((s) => ({
      name: s.name,
      state: statusState(s.status, s.allow_failure),
      url: s.target_url ?? null,
      summary: s.description ?? null,
    }));
    return { state: checksState(runs), runs };
  }

  private async mergeRequest(project: string, iid: number): Promise<any> {
    const res = await this.call("GET", `${this.api(project)}/merge_requests/${iid}`);
    if (res.status !== 200) throw new GitProviderError(`GitLab ${res.status} reading merge request !${iid}`);
    return res.body;
  }

  private required(repoUrl: string): string {
    const project = this.projectPath(repoUrl);
    if (!project) throw new GitProviderError(`not a repository on ${this.host}: ${repoUrl}`);
    return project;
  }

  private api(project: string): string {
    return `${this.baseUrl}/api/v4/projects/${encodeURIComponent(project)}`;
  }

  private call(method: string, url: string, body?: object): Promise<{ status: number; body: any }> {
    const target = url.slice(this.baseUrl.length).split("?")[0];
    return withSpan(`gitlab ${method} ${target}`, { "http.request.method": method, "url.path": target }, async (span) => {
      const res = await this.fetchImpl(url, {
        method,
        headers: { "private-token": this.token, ...(body && { "content-type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      span.setAttribute("http.response.status_code", res.status);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }, { kind: SpanKind.CLIENT });
  }
}

/** GitLab job and commit statuses; failures allowed to fail do not block. */
function statusState(status: string, allowFailure?: boolean): CheckRun["state"] {
  if (status === "success") return "success";
  if (["pending", "running", "created", "waiting_for_resource", "preparing", "scheduled"].includes(status)) return "pending";
  if (status === "skipped" || status === "manual") return "neutral";
  return allowFailure ? "neutral" : "failure";
}

function toRef(mr: { web_url: string; iid: number }): PullRequestRef {
  return { url: mr.web_url, number: mr.iid };
}
