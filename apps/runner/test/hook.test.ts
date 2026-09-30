import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY_HOOK_SCRIPT } from "../src/runner.js";

let server: Server;
let baseUrl: string;
const received: Array<{ url: string | undefined; token: string | string[] | undefined; body: unknown }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      const body = JSON.parse(raw);
      received.push({ url: req.url, token: req.headers["x-mar-execution-token"], body });
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
function runHook(dialect: string, payload: object, env: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [POLICY_HOOK_SCRIPT, dialect], {
      env: {
        ...process.env,
        MAR_CONTROL_PLANE_URL: baseUrl,
        MAR_EXECUTION_ID: "exec-1",
        MAR_EXECUTION_TOKEN: "tok-1",
        ...env,
      },
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
      { MAR_CONTROL_PLANE_URL: "http://127.0.0.1:1" },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/policy hook error/);
  });

  it("fails closed without its environment or with an unknown dialect", async () => {
    expect((await runHook("agy", { toolCall: { name: "x" } }, { MAR_EXECUTION_TOKEN: "" })).decision).toBe("deny");
    expect((await runHook("vim", { tool: "x" })).decision).toBe("deny");
  });
});
