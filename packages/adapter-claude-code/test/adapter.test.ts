import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mar/core";
import { ClaudeCodeAdapter } from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

function parse(lines: string[]): AgentEvent[] {
  const parser = new ClaudeCodeAdapter().createParser();
  return lines.flatMap((l) => parser.push(l));
}

describe("ClaudeCodeAdapter.buildCommand", () => {
  it("builds an isolated headless command with the prompt on stdin", () => {
    const cmd = new ClaudeCodeAdapter({ settings: { hooks: {} } }).buildCommand({
      workspace: "/ws/TASK-1",
      prompt: "Implement the refund API", objective: "Implement the refund API",
      permissionProfile: "edit",
      resumeSessionId: "abc",
      outputSchema: { type: "object" },
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.cwd).toBe("/ws/TASK-1");
    expect(cmd.stdin).toBe("Implement the refund API");
    expect(cmd.args).toEqual(
      expect.arrayContaining(["-p", "stream-json", "--verbose", "project,local", "--strict-mcp-config", "acceptEdits"]),
    );
    const joined = cmd.args.join(" ");
    expect(joined).toContain("--resume abc");
    expect(joined).toContain('--json-schema {"type":"object"}');
    expect(joined).toContain('--settings {"hooks":{}}');
  });

  it("injects the policy hook through --settings, merged with configured settings", () => {
    const cmd = new ClaudeCodeAdapter({ settings: { model: "x" } }).buildCommand({
      workspace: "/ws",
      prompt: "x", objective: "x",
      permissionProfile: "edit",
      env: { MAR_EXECUTION_ID: "e1" },
      policyHook: { command: "node", args: ["/hook.mjs"] },
    });
    const settings = JSON.parse(cmd.args[cmd.args.indexOf("--settings") + 1]!);
    expect(settings).toEqual({
      model: "x",
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: '"node" "/hook.mjs" "claude"', timeout: 30 }] },
        ],
      },
    });
    expect(cmd.env).toEqual({ MAR_EXECUTION_ID: "e1" });
  });

  it("omits --settings when there is nothing to inject", () => {
    const cmd = new ClaudeCodeAdapter().buildCommand({ workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "edit" });
    expect(cmd.args).not.toContain("--settings");
  });

  it("uses plan mode for read-only runs", () => {
    const cmd = new ClaudeCodeAdapter().buildCommand({ workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "read-only" });
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
});

describe("ClaudeStreamParser (recorded Claude Code 2.1.284 run)", () => {
  const events = parse(fixture("write-file.stream.jsonl"));

  it("emits session, tool call/result, message and completion in order", () => {
    expect(events.map((e) => e.kind)).toEqual(["session_started", "tool_call", "tool_result", "message", "completed"]);
  });

  it("captures the session id for resume", () => {
    expect(events[0]).toMatchObject({ kind: "session_started", sessionId: "f1c09bfa-6b76-4b82-a2a3-3716d2f93928" });
  });

  it("pairs tool results with their tool name", () => {
    expect(events[1]).toMatchObject({ kind: "tool_call", tool: "Write" });
    expect(events[2]).toMatchObject({ kind: "tool_result", tool: "Write", ok: true });
  });

  it("reports cost and success on completion", () => {
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: "completed", success: true, result: "DONE", deniedActions: [] });
    expect(done?.kind === "completed" && done.costUsd).toBeGreaterThan(0);
  });

  it("treats permission denials as non-success", () => {
    const out = new ClaudeCodeAdapter().createParser().push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s1",
        result: "",
        permission_denials: [{ tool_name: "Bash" }],
      }),
    );
    expect(out).toEqual([
      { kind: "permission_denied", tool: "Bash" },
      expect.objectContaining({ kind: "completed", success: false, deniedActions: ["Bash"] }),
    ]);
  });

  it("turns non-JSON lines into diagnostics", () => {
    expect(new ClaudeCodeAdapter().createParser().push("warning: something")).toEqual([
      { kind: "diagnostic", text: "warning: something" },
    ]);
  });
});
