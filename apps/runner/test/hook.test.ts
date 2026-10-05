import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY_HOOK_SCRIPT } from "../src/runner.js";

let server: Server;
let baseUrl: string;
/** Number of upcoming requests answered with 503. */
let failNext = 0;
const received: Array<{
  url: string | undefined;
  token: string | string[] | undefined;
  traceparent?: string | string[] | undefined;
  body: unknown;
}> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(503);
        return res.end();
      }
      const body = JSON.parse(raw);
      received.push({ url: req.url, token: req.headers["x-mar-execution-token"], traceparent: req.headers.traceparent, body });
      const deny = JSON.stringify(body).includes("push");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          deny
            ? { decision: "deny", risk: "CRITICAL", reason: "no pushing", summary: "" }
            : { decision: "allow", risk: "LOW", reason: "fine", summary: "" },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Async spawn: the policy server runs in this process, so the event loop must stay free.
/** `undefined` removes a variable, as a CLI that filters its hooks' environment does. */
function runHook(dialect: string, payload: object, env: Record<string, string | undefined> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      MAR_CONTROL_PLANE_URL: baseUrl,
      MAR_EXECUTION_ID: "exec-1",
      MAR_EXECUTION_TOKEN: "tok-1",
      ...env,
    };
    const child = spawn(process.execPath, [POLICY_HOOK_SCRIPT, dialect], {
      env: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)),
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`hook exited with ${code}`));
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("mar-policy-hook", () => {
  it("speaks Claude Code's PreToolUse format", async () => {
    const out = await runHook("claude", { tool_name: "PowerShell", tool_input: { command: "git status" } });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "[LOW] fine" },
    });
    expect(received.at(-1)).toEqual({
      url: "/executions/exec-1/tool-check",
      token: "tok-1",
      body: { tool: "PowerShell", input: { command: "git status" } },
    });
  });

  it("speaks Antigravity's hook format", async () => {
    const out = await runHook("agy", { toolCall: { name: "run_command", args: { CommandLine: "git push" } } });
    expect(out).toEqual({ decision: "deny", reason: "[CRITICAL] no pushing" });
  });

  it("fails closed when the policy service is unreachable", async () => {
    const out = await runHook(
      "agy",
      { toolCall: { name: "run_command", args: {} } },
      { MAR_CONTROL_PLANE_URL: "http://127.0.0.1:1", MAR_POLICY_HOOK_BUDGET_MS: "300" },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/policy service unavailable/);
  });

  it("retries through a temporary 5xx before deciding", async () => {
    failNext = 2;
    const out = await runHook("agy", { toolCall: { name: "view_file", args: {} } });
    expect(out).toEqual({ decision: "allow", reason: "[LOW] fine" });
    expect(failNext).toBe(0);
  });

  it("passes the execution trace on to the policy check", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await runHook("agy", { toolCall: { name: "view_file", args: {} } }, { TRACEPARENT: traceparent });
    expect(received.at(-1)?.traceparent).toBe(traceparent);
    await runHook("agy", { toolCall: { name: "view_file", args: {} } });
    expect(received.at(-1)?.traceparent).toBeUndefined();
  });

  it("never sends secret values and says when a call carries one (spec §48)", async () => {
    const env = { MAR_SECRET_NAMES: "NPM_TOKEN", NPM_TOKEN: 'npm_"quoted"_1234' };
    await runHook("json", { tool: "Write", input: { file_path: ".npmrc", content: 'token=npm_"quoted"_1234' } }, env);
    expect(received.at(-1)!.body).toEqual({
      tool: "Write",
      input: { file_path: ".npmrc", content: "token=[secret NPM_TOKEN]" },
      containsSecret: "NPM_TOKEN",
    });
    await runHook("json", { tool: "Bash", input: { command: "npm whoami" } }, env);
    expect(received.at(-1)!.body).toEqual({ tool: "Bash", input: { command: "npm whoami" } });
  });

  it("takes credential-like variables a CLI filtered out from MAR_HOOK_CONTEXT (Command Code)", async () => {
    const context = JSON.stringify({ MAR_EXECUTION_TOKEN: "tok-ctx", NPM_TOKEN: "npm_secret_1234" });
    const filtered = { MAR_EXECUTION_TOKEN: undefined, NPM_TOKEN: undefined, MAR_SECRET_NAMES: "NPM_TOKEN", MAR_HOOK_CONTEXT: context };
    await runHook("claude", { tool_name: "shell_command", tool_input: { command: "echo npm_secret_1234" } }, filtered);
    expect(received.at(-1)).toMatchObject({
      token: "tok-ctx",
      body: { tool: "shell_command", input: { command: "echo [secret NPM_TOKEN]" }, containsSecret: "NPM_TOKEN" },
    });
    // A variable the CLI did pass wins over the context.
    await runHook("claude", { tool_name: "read_file", tool_input: {} }, { MAR_HOOK_CONTEXT: context });
    expect(received.at(-1)!.token).toBe("tok-1");
    // A broken context fails closed.
    const broken = await runHook("claude", { tool_name: "read_file", tool_input: {} }, { MAR_EXECUTION_TOKEN: undefined, MAR_HOOK_CONTEXT: "{" });
    expect(broken.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("fails closed without its environment or with an unknown dialect", async () => {
    expect((await runHook("agy", { toolCall: { name: "x" } }, { MAR_EXECUTION_TOKEN: "" })).decision).toBe("deny");
    expect((await runHook("vim", { tool: "x" })).decision).toBe("deny");
  });
});
