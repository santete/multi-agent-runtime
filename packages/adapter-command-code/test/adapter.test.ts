import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRunRequest } from "@mar/core";
import { COMMAND_CODE_SETTINGS_FILE, CommandCodeAdapter } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

function parse(lines: string[]): AgentEvent[] {
  const parser = new CommandCodeAdapter().createParser();
  return [...lines.flatMap((l) => parser.push(l)), ...parser.finish(0)];
}

const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  workspace: "/ws/TASK-1",
  prompt: "Implement the refund API",
  objective: "Implement the refund API",
  permissionProfile: "edit",
  ...extra,
});
const hook = { command: "node", args: ["/hook.mjs"] };

describe("CommandCodeAdapter.buildCommand", () => {
  it("bypasses print mode's permission check only when the policy hook decides", () => {
    const cmd = new CommandCodeAdapter().buildCommand(request({ policyHook: hook, resumeSessionId: "s1", model: "deepseek/deepseek-v4-pro", env: { A: "1" } }));
    expect(cmd.command).toBe("command-code");
    expect(cmd.cwd).toBe("/ws/TASK-1");
    expect(cmd.env).toEqual({ A: "1" });
    expect(cmd.args.join(" ")).toBe(
      "-p --output-format json --skip-onboarding --no-auto-update --yolo --resume s1 --model deepseek/deepseek-v4-pro",
    );
    expect(cmd.stdin).toBe("Implement the refund API");
  });

  it("passes the variables Command Code hides from hooks in MAR_HOOK_CONTEXT", () => {
    const env = { MAR_CONTROL_PLANE_URL: "http://cp", MAR_EXECUTION_ID: "e1", MAR_EXECUTION_TOKEN: "tok", STRIPE_API_KEY: "sk_1", MAR_SECRET_NAMES: "STRIPE_API_KEY" };
    const cmd = new CommandCodeAdapter().buildCommand(request({ policyHook: hook, env }));
    expect(JSON.parse(cmd.env!.MAR_HOOK_CONTEXT!)).toEqual({ MAR_EXECUTION_TOKEN: "tok", STRIPE_API_KEY: "sk_1", MAR_SECRET_NAMES: "STRIPE_API_KEY" });
    expect(cmd.env).toMatchObject(env);
    // No hook, nothing to pass.
    expect(new CommandCodeAdapter().buildCommand(request({ env })).env).toEqual(env);
  });

  it("never bypasses permissions without the hook", () => {
    const cmd = new CommandCodeAdapter().buildCommand(request());
    expect(cmd.args).not.toContain("--yolo");
    expect(cmd.args.join(" ")).toContain("--permission-mode auto-accept");
  });

  it("uses plan mode for read-only runs, hook or not", () => {
    const cmd = new CommandCodeAdapter().buildCommand(request({ permissionProfile: "read-only", policyHook: hook }));
    expect(cmd.args).not.toContain("--yolo");
    expect(cmd.args.join(" ")).toContain("--permission-mode plan");
  });

  it("appends the output schema to the prompt", () => {
    const cmd = new CommandCodeAdapter({ executable: "C:/npm/command-code.cmd" }).buildCommand(request({ outputSchema: { type: "object" } }));
    expect(cmd.command).toBe("C:/npm/command-code.cmd");
    expect(cmd.stdin).toMatch(/^Implement the refund API\n\nYour final message must be only a JSON object/);
    expect(cmd.stdin).toContain('{"type":"object"}');
  });
});

describe("CommandCodeAdapter.workspaceFiles", () => {
  it("installs a fail-closed policy hook and turns taste learning off", () => {
    expect(new CommandCodeAdapter().workspaceFiles(request({ policyHook: hook }))).toEqual([
      {
        path: COMMAND_CODE_SETTINGS_FILE,
        mergeJson: true,
        content: {
          tasteLearning: false,
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: '"node" "/hook.mjs" "claude"', timeout: 120, failClosed: true }] }],
          },
        },
      },
    ]);
  });

  it("still turns taste learning off without a hook", () => {
    expect(new CommandCodeAdapter().workspaceFiles(request())).toEqual([
      { path: COMMAND_CODE_SETTINGS_FILE, mergeJson: true, content: { tasteLearning: false } },
    ]);
  });
});

describe("CommandCodeStreamParser", () => {
  it("reports tool calls, results and calls blocked by the hook", () => {
    const events = parse(fixture("hook-blocked.jsonl"));
    expect(events[0]).toEqual({ kind: "session_started", sessionId: "c849852d-ebb7-40b0-86fd-314c3cf452b1" });
    expect(events.filter((e) => e.kind === "tool_call").map((e) => e.kind === "tool_call" && e.tool)).toEqual(["write_file", "shell_command"]);
    expect(events).toContainEqual({
      kind: "tool_result",
      callId: "call_00_WQVMuS56wjMyIzc0XUVi9634",
      tool: "write_file",
      ok: true,
      output: "File created successfully at: /ws/TASK-1\\b.txt",
    });
    expect(events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "shell_command", detail: "[HIGH] command needs approval: node -e" },
    ]);
    expect(events.some((e) => e.kind === "message" && e.text.startsWith("Here's what happened"))).toBe(true);
    // The info notice about updates is not shown.
    expect(events.some((e) => e.kind === "diagnostic")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "completed",
      sessionId: "c849852d-ebb7-40b0-86fd-314c3cf452b1",
      success: false,
      deniedActions: ["shell_command"],
      usage: { inputTokens: 58816, outputTokens: 383, cacheReadTokens: 37376 },
    });
  });

  it("parses the structured answer of a read-only run", () => {
    const done = parse(fixture("structured-plan.jsonl")).at(-1);
    expect(done).toMatchObject({ kind: "completed", success: true, result: { count: 2, names: ["a.txt", "b.txt"] }, deniedActions: [] });
  });

  it("treats print mode refusing a call (read-only runs) as a failed call, not a policy denial", () => {
    const blocked = JSON.stringify({
      type: "event",
      event: {
        type: "tool_hook_blocked",
        toolCallId: "c1",
        toolName: "write_file",
        hookOutput: 'Error: Tool "write_file" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode.',
      },
    });
    const events = parse([blocked, JSON.stringify({ type: "result", subtype: "success", sessionId: "s", finalText: "could not write" })]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_result", tool: "write_file", ok: false }));
    expect(events.some((e) => e.kind === "permission_denied")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "completed", success: true, deniedActions: [], result: "could not write" });
  });

  it("does not treat plan mode refusing a write as a policy denial", () => {
    const denied = JSON.stringify({ type: "event", event: { type: "tool_denied", toolCallId: "c2", toolName: "write_file" } });
    const events = parse([denied, JSON.stringify({ type: "result", subtype: "success", sessionId: "s", finalText: "{}" })]);
    expect(events).toContainEqual({ kind: "tool_result", callId: "c2", tool: "write_file", ok: false, output: "not permitted in this mode" });
    expect(events.some((e) => e.kind === "permission_denied")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "completed", success: true, deniedActions: [] });
  });

  it("reports errors, turn caps and runs without a result", () => {
    expect(parse([JSON.stringify({ type: "result", subtype: "error", sessionId: "s", error: "rate limited" })]).at(-1)).toEqual({
      kind: "failed",
      sessionId: "s",
      reason: "rate limited",
    });
    expect(parse([JSON.stringify({ type: "result", subtype: "max_turns", sessionId: "s", finalText: "partial" })]).at(-1)).toMatchObject({
      kind: "completed",
      success: false,
    });
    const parser = new CommandCodeAdapter().createParser();
    parser.push(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "s9" } }));
    expect(parser.finish(1)).toMatchObject([{ kind: "failed", sessionId: "s9" }]);
  });
});
