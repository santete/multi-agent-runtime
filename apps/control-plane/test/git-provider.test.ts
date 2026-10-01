import { describe, expect, it } from "vitest";
import { checksState, GitHubProvider, GitProviderError, parseGitHubRepo } from "../src/git-provider.js";

describe("parseGitHubRepo", () => {
  it.each([
    ["https://github.com/santete/multi-agent-runtime.git", "santete", "multi-agent-runtime"],
    ["https://github.com/santete/multi-agent-runtime", "santete", "multi-agent-runtime"],
    ["git@github.com:santete/multi-agent-runtime.git", "santete", "multi-agent-runtime"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseGitHubRepo(url)).toEqual({ owner, repo });
  });

  it("ignores other hosts and local paths", () => {
    expect(parseGitHubRepo("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseGitHubRepo("C:\\repos\\thing")).toBeNull();
  });
});

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization"),
    });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const req = {
  repoUrl: "https://github.com/o/r.git",
  head: "task/PAY-1",
  base: "main",
  title: "PAY-1: Refund",
  body: "b",
};

describe("GitHubProvider", () => {
  it("opens a pull request with the token", async () => {
    const f = fakeFetch([{ status: 201, body: { html_url: "https://github.com/o/r/pull/7", number: 7 } }]);
    const pr = await new GitHubProvider("t0k", "https://api.test", f.impl).openPullRequest(req);
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
    expect(f.calls[0]).toEqual({
      url: "https://api.test/repos/o/r/pulls",
      method: "POST",
      body: { title: "PAY-1: Refund", head: "task/PAY-1", base: "main", body: "b" },
      auth: "Bearer t0k",
    });
  });

  it("returns the existing pull request when one is already open for the branch", async () => {
    const f = fakeFetch([
      { status: 422, body: { message: "Validation Failed" } },
      { status: 200, body: [{ html_url: "https://github.com/o/r/pull/3", number: 3 }] },
    ]);
    const pr = await new GitHubProvider("t", "https://api.test", f.impl).openPullRequest(req);
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/3", number: 3 });
    expect(f.calls[1]!.url).toBe("https://api.test/repos/o/r/pulls?state=open&head=o%3Atask%2FPAY-1");
  });

  it("does not handle non-GitHub repositories", async () => {
    const f = fakeFetch([]);
    expect(await new GitHubProvider("t", "x", f.impl).openPullRequest({ ...req, repoUrl: "/local/repo" })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("raises on other errors", async () => {
    const f = fakeFetch([{ status: 403, body: { message: "Resource not accessible" } }]);
    await expect(new GitHubProvider("t", "x", f.impl).openPullRequest(req)).rejects.toThrow(GitProviderError);
  });
});

describe("pull request status", () => {
  it("reports whether the base moved and combines check runs with commit statuses", async () => {
    const f = fakeFetch([
      { status: 200, body: { head: { sha: "h1" }, base: { ref: "main" } } },
      { status: 200, body: { behind_by: 2, ahead_by: 1 } },
      {
        status: 200,
        body: {
          check_runs: [
            { id: 11, name: "test", status: "completed", conclusion: "failure", html_url: "https://ci/1", output: { title: "1 failing", summary: "refund rounds", annotations_count: 2 } },
            { name: "lint", status: "completed", conclusion: "skipped", html_url: null, output: {} },
            { name: "e2e", status: "in_progress", conclusion: null, html_url: null, output: {} },
          ],
        },
      },
      { status: 200, body: { statuses: [{ context: "deploy/preview", state: "success", target_url: "https://p", description: "ok" }] } },
      {
        status: 200,
        body: [
          { path: ".github", start_line: 1, annotation_level: "failure", message: "Process completed with exit code 1." },
          { path: "src/payments.js", start_line: 12, annotation_level: "failure", message: "TODO comments are not allowed" },
        ],
      },
    ]);
    const status = await new GitHubProvider("t", "https://api.test", f.impl).pullRequestStatus({ repoUrl: "https://github.com/o/r", number: 5 });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.test/repos/o/r/pulls/5",
      "https://api.test/repos/o/r/compare/main...h1",
      "https://api.test/repos/o/r/commits/h1/check-runs?per_page=100",
      "https://api.test/repos/o/r/commits/h1/status",
      "https://api.test/repos/o/r/check-runs/11/annotations?per_page=10",
    ]);
    expect(status).toEqual({
      headSha: "h1",
      behindBase: true,
      checks: {
        state: "failure",
        runs: [
          {
            name: "test",
            state: "failure",
            url: "https://ci/1",
            summary: "refund rounds\nProcess completed with exit code 1.\nsrc/payments.js:12: TODO comments are not allowed",
          },
          { name: "lint", state: "neutral", url: null, summary: null },
          { name: "e2e", state: "pending", url: null, summary: null },
          { name: "deploy/preview", state: "success", url: "https://p", summary: "ok" },
        ],
      },
    });
  });

  it("combines check states", () => {
    const run = (state: "pending" | "success" | "failure" | "neutral") => ({ name: state, state, url: null, summary: null });
    expect(checksState([])).toBe("none");
    expect(checksState([run("success"), run("neutral")])).toBe("success");
    expect(checksState([run("success"), run("pending")])).toBe("pending");
    expect(checksState([run("pending"), run("failure")])).toBe("failure");
  });
});

describe("revert pull request", () => {
  it("uses GitHub's revertPullRequest mutation", async () => {
    const f = fakeFetch([
      { status: 200, body: { node_id: "PR_kw1", number: 7 } },
      { status: 200, body: { data: { revertPullRequest: { revertPullRequest: { url: "https://github.com/o/r/pull/9", number: 9 } } } } },
    ]);
    const pr = await new GitHubProvider("t", "https://api.test", f.impl).revertPullRequest({
      repoUrl: "https://github.com/o/r",
      number: 7,
      title: "Revert PAY-1",
      body: "broke main",
    });
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/9", number: 9 });
    expect(f.calls[1]).toMatchObject({
      url: "https://api.test/graphql",
      method: "POST",
      body: { variables: { id: "PR_kw1", title: "Revert PAY-1", body: "broke main" } },
    });
  });

  it("reports GraphQL errors", async () => {
    const f = fakeFetch([
      { status: 200, body: { node_id: "PR_kw1" } },
      { status: 200, body: { errors: [{ message: "Pull request is not merged" }] } },
    ]);
    await expect(
      new GitHubProvider("t", "https://api.test", f.impl).revertPullRequest({ repoUrl: "https://github.com/o/r", number: 7, title: "x", body: "y" }),
    ).rejects.toThrow(/not merged/);
  });
});
