import { describe, expect, it } from "vitest";
import { GitHubProvider, GitLabProvider, GitProviderError, RoutingGitProvider } from "../src/index.js";

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; token: string | null }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      token: new Headers(init.headers).get("private-token"),
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${init.method} ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const repoUrl = "https://gitlab.com/acme/payments/api.git";
const api = "https://gitlab.com/api/v4/projects/acme%2Fpayments%2Fapi";
const mr = (o: object = {}) => ({
  iid: 7,
  web_url: "https://gitlab.com/acme/payments/api/-/merge_requests/7",
  state: "opened",
  sha: "h1",
  target_branch: "main",
  has_conflicts: false,
  detailed_merge_status: "mergeable",
  ...o,
});

describe("GitLabProvider", () => {
  it("recognizes repositories on its own host, groups and subgroups included", () => {
    const gl = new GitLabProvider("t");
    expect(gl.projectPath("https://gitlab.com/acme/payments/api.git")).toBe("acme/payments/api");
    expect(gl.projectPath("git@gitlab.com:acme/api.git")).toBe("acme/api");
    expect(gl.projectPath("https://github.com/acme/api.git")).toBeNull();
    expect(gl.projectPath("https://gitlab.com/just-a-group")).toBeNull();
    const own = new GitLabProvider("t", "https://git.acme.internal/");
    expect(own.projectPath("https://git.acme.internal/team/api")).toBe("team/api");
    expect(own.handles("https://gitlab.com/team/api")).toBe(false);
  });

  it("opens a merge request, or finds the open one of the branch on re-delivery", async () => {
    const f = fakeFetch([{ status: 201, body: mr() }]);
    const gl = new GitLabProvider("glpat-x", "https://gitlab.com", f.impl);
    const req = { repoUrl, head: "task/PAY-1", base: "main", title: "PAY-1: Refund", body: "b" };
    expect(await gl.openPullRequest(req)).toEqual({ url: mr().web_url, number: 7 });
    expect(f.calls[0]).toMatchObject({
      url: `${api}/merge_requests`,
      method: "POST",
      token: "glpat-x",
      body: { source_branch: "task/PAY-1", target_branch: "main", title: "PAY-1: Refund", description: "b", remove_source_branch: true, squash: true },
    });

    const again = fakeFetch([
      { status: 409, body: { message: ["Another open merge request already exists for this source branch: !7"] } },
      { status: 200, body: [mr()] },
    ]);
    expect(await new GitLabProvider("t", "https://gitlab.com", again.impl).openPullRequest(req)).toEqual({ url: mr().web_url, number: 7 });
    expect(again.calls[1]!.url).toBe(`${api}/merge_requests?state=opened&source_branch=task%2FPAY-1`);
    expect(await gl.openPullRequest({ ...req, repoUrl: "/local/repo" })).toBeNull();
  });

  it("squash-merges, and tells conflicts and not-yet-mergeable apart", async () => {
    const req = { repoUrl, number: 7, head: "task/PAY-1", commitTitle: "PAY-1: Refund (!7)" };
    const ok = fakeFetch([{ status: 200, body: mr() }, { status: 200, body: mr({ state: "merged", merge_commit_sha: "m1" }) }]);
    expect(await new GitLabProvider("t", undefined, ok.impl).mergePullRequest(req)).toEqual({ status: "merged", sha: "m1" });
    expect(ok.calls[1]).toMatchObject({
      method: "PUT",
      url: `${api}/merge_requests/7/merge`,
      body: { squash: true, squash_commit_message: "PAY-1: Refund (!7)", should_remove_source_branch: true },
    });

    const cases: Array<[unknown[], string]> = [
      [[{ status: 200, body: mr({ state: "merged", squash_commit_sha: "s1" }) }], "merged"],
      [[{ status: 200, body: mr({ has_conflicts: true }) }], "conflict"],
      [[{ status: 200, body: mr({ detailed_merge_status: "checking" }) }], "pending"],
      [[{ status: 200, body: mr() }, { status: 406, body: { message: "Branch cannot be merged" } }], "conflict"],
      [[{ status: 200, body: mr() }, { status: 405, body: { message: "Method Not Allowed" } }], "pending"],
    ];
    for (const [responses, status] of cases) {
      const f = fakeFetch(responses as Array<{ status: number; body: unknown }>);
      expect((await new GitLabProvider("t", undefined, f.impl).mergePullRequest(req)).status).toBe(status);
    }
    const closed = fakeFetch([{ status: 200, body: mr({ state: "closed" }) }]);
    await expect(new GitLabProvider("t", undefined, closed.impl).mergePullRequest(req)).rejects.toThrow(GitProviderError);
  });

  it("reports CI from commit statuses and whether the target moved", async () => {
    const f = fakeFetch([
      { status: 200, body: mr() },
      { status: 200, body: { commits: [{ id: "c9" }] } },
      {
        status: 200,
        body: [
          { id: 1, name: "test", status: "failed", target_url: "https://gitlab.com/j/1", description: "exit 1" },
          { id: 3, name: "test", status: "success", target_url: "https://gitlab.com/j/3" },
          { id: 2, name: "lint", status: "failed", allow_failure: true },
          { id: 4, name: "deploy", status: "manual" },
          { id: 5, name: "e2e", status: "running" },
        ],
      },
    ]);
    const status = await new GitLabProvider("t", undefined, f.impl).pullRequestStatus({ repoUrl, number: 7 });
    expect(status).toEqual({
      headSha: "h1",
      behindBase: true,
      checks: {
        state: "pending",
        runs: [
          { name: "test", state: "success", url: "https://gitlab.com/j/3", summary: null },
          { name: "lint", state: "neutral", url: null, summary: null },
          { name: "deploy", state: "neutral", url: null, summary: null },
          { name: "e2e", state: "pending", url: null, summary: null },
        ],
      },
    });
    expect(f.calls[1]!.url).toBe(`${api}/repository/compare?from=h1&to=main`);
  });

  it("reverts a merged merge request through a new branch and merge request", async () => {
    const f = fakeFetch([
      { status: 200, body: mr({ state: "merged", squash_commit_sha: "s1" }) },
      { status: 201, body: { name: "revert-mr-7" } },
      { status: 201, body: { id: "r1" } },
      { status: 201, body: mr({ iid: 8, web_url: "https://gitlab.com/acme/payments/api/-/merge_requests/8" }) },
    ]);
    const ref = await new GitLabProvider("t", undefined, f.impl).revertPullRequest({ repoUrl, number: 7, title: "Revert", body: "main broke" });
    expect(ref).toEqual({ url: "https://gitlab.com/acme/payments/api/-/merge_requests/8", number: 8 });
    expect(f.calls.map((c) => `${c.method} ${c.url.slice(api.length)}`)).toEqual([
      "GET /merge_requests/7",
      "POST /repository/branches",
      "POST /repository/commits/s1/revert",
      "POST /merge_requests",
    ]);
    expect(f.calls[2]!.body).toEqual({ branch: "revert-mr-7" });
  });
});

describe("RoutingGitProvider", () => {
  it("sends each repository to the provider of its host", async () => {
    const gh = fakeFetch([{ status: 201, body: { html_url: "https://github.com/o/r/pull/1", number: 1 } }]);
    const gl = fakeFetch([{ status: 201, body: mr() }]);
    const routing = new RoutingGitProvider([new GitHubProvider("g", "https://api.test", gh.impl), new GitLabProvider("l", undefined, gl.impl)]);
    const req = { head: "task/PAY-1", base: "main", title: "t", body: "b" };
    expect((await routing.openPullRequest({ ...req, repoUrl: "https://github.com/o/r.git" }))?.number).toBe(1);
    expect((await routing.openPullRequest({ ...req, repoUrl }))?.number).toBe(7);
    expect(await routing.openPullRequest({ ...req, repoUrl: "https://bitbucket.org/o/r.git" })).toBeNull();
    await expect(routing.mergePullRequest({ repoUrl: "https://bitbucket.org/o/r.git", number: 1, head: "h", commitTitle: "c" })).rejects.toThrow(
      "no git provider configured",
    );
  });
});
