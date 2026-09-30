import { describe, expect, it } from "vitest";
import { GitHubProvider, GitProviderError, parseGitHubRepo } from "../src/git-provider.js";

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
