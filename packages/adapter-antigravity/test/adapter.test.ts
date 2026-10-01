import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mar/core";
import { AntigravityAdapter } from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

function parse(lines: string[]): AgentEvent[] {
  const parser = new AntigravityAdapter().createParser();
  return lines.flatMap((l) => parser.push(l));
}

describe("AntigravityAdapter.buildCommand", () => {
  it("builds a headless command with a bounded timeout", () => {
    const cmd = new AntigravityAdapter({ executable: "agy.exe" }).buildCommand({
      workspace: "/ws/TASK-2",
      prompt: "Write tests", objective: "Write tests",
      permissionProfile: "edit",
      resumeSessionId: "conv-1",
      model: "gemini-3.8-flash-high",
    });
    expect(cmd.command).toBe("agy.exe");
    expect(cmd.args.slice(0, 2)).toEqual(["-p", "Write tests"]);
    const joined = cmd.args.join(" ");
    expect(joined).toContain("--print-timeout 1800s");
    expect(joined).toContain("--mode accept-edits");
    expect(joined).toContain("--conversation conv-1");
    expect(joined).toContain("--model gemini-3.8-flash-high");
  });

  it("installs the policy hook as a merged workspace hooks.json and passes env", () => {
    const request = {
      workspace: "/ws",
      prompt: "x", objective: "x",
      permissionProfile: "edit" as const,
      env: { MAR_EXECUTION_ID: "e1" },
      policyHook: { command: "C:\\Program Files\\node.exe", args: ["C:\\hook.mjs"] },
    };
    const hooksJson = (command: string) => [
      {
        path: ".agents/hooks.json",
        mergeJson: true,
        content: { "mar-policy": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 120 }] }] } },
      },
    ];

    // Windows: quote-free env var reference; agy mangles quoted hook commands there.
    const windows = new AntigravityAdapter({ platform: "win32" });
    expect(windows.workspaceFiles(request)).toEqual(hooksJson("%MAR_POLICY_HOOK%"));
    expect(windows.buildCommand(request).env).toEqual({
      MAR_EXECUTION_ID: "e1",
      MAR_POLICY_HOOK: '"C:\\Program Files\\node.exe" "C:\\hook.mjs" "agy"',
    });

    const linux = new AntigravityAdapter({ platform: "linux" });
    expect(linux.workspaceFiles(request)).toEqual(hooksJson('"C:\\Program Files\\node.exe" "C:\\hook.mjs" "agy"'));
    expect(linux.buildCommand(request).env).toEqual({ MAR_EXECUTION_ID: "e1" });

    expect(windows.workspaceFiles({ ...request, policyHook: undefined as never })).toEqual([]);
  });

  it("runs unattended in agy's sandbox only when opted in and policed by the hook", () => {
    const request = {
      workspace: "/ws",
      prompt: "x",
      objective: "x",
      permissionProfile: "edit" as const,
      policyHook: { command: "node", args: ["hook.mjs"] },
    };
    const unattended = new AntigravityAdapter({ unattended: true });
    const flags = (args: string[]) => args.filter((a) => a === "--sandbox" || a === "--dangerously-skip-permissions");

    expect(flags(unattended.buildCommand(request).args)).toEqual(["--sandbox", "--dangerously-skip-permissions"]);
    // Never without the policy hook, never for read-only work, never unless opted in.
    expect(flags(unattended.buildCommand({ ...request, policyHook: undefined as never }).args)).toEqual([]);
    expect(flags(unattended.buildCommand({ ...request, permissionProfile: "read-only" }).args)).toEqual([]);
    expect(flags(new AntigravityAdapter().buildCommand(request).args)).toEqual([]);
  });
});

describe("AntigravityStreamParser: tools blocked by the policy hook", () => {
  const step = (state: string, extra: object = {}) =>
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 2, state, step_type: "tool", tool_name: "run_command", ...extra },
    });

  it("counts hook denials as denied actions even though agy reports SUCCESS", () => {
    const parser = new AntigravityAdapter().createParser();
    parser.push(step("ACTIVE", { tool_info: { name: "run_command", parameters: { CommandLine: "git push" } } }));
    const blocked = parser.push(
      step("ERROR", {
        tool_info: { error: { type: "TOOL_ERROR", message: "tool call denied by pre-tool hook: [CRITICAL] no pushing" } },
      }),
    );
    expect(blocked).toEqual([
      { kind: "tool_result", callId: "2", tool: "run_command", ok: false, output: expect.stringContaining("pre-tool hook") },
      { kind: "permission_denied", tool: "run_command", detail: expect.stringContaining("no pushing") },
    ]);
    const done = parser.push(JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS" } }));
    expect(done.at(-1)).toMatchObject({ kind: "completed", success: false, deniedActions: ["run_command"] });
  });

  it("keeps ordinary tool errors as plain failures", () => {
    const parser = new AntigravityAdapter().createParser();
    const out = parser.push(step("ERROR", { tool_info: { error: { message: "file not found: x.ts" } } }));
    expect(out).toEqual([{ kind: "tool_result", callId: "2", tool: "run_command", ok: false, output: "file not found: x.ts" }]);
    const done = parser.push(JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS" } }));
    expect(done.at(-1)).toMatchObject({ success: true });
  });
});

describe("AntigravityStreamParser (recorded agy 1.2.13 runs)", () => {
  it("parses a successful edit run", () => {
    const events = parse(fixture("write-file.stream.jsonl"));
    expect(events.map((e) => e.kind)).toEqual([
      "session_started",
      "usage",
      "tool_call",
      "tool_result",
      "message",
      "usage",
      "completed",
    ]);
    expect(events[0]).toMatchObject({ sessionId: "3edf2479-ae3b-4364-a2a1-cd980bc0b0e6" });
    expect(events[2]).toMatchObject({ kind: "tool_call", tool: "write_to_file" });
    expect(events[3]).toMatchObject({ kind: "tool_result", tool: "write_to_file", ok: true });
    expect(events[4]).toMatchObject({ kind: "message", text: expect.stringContaining("DONE") });
    expect(events.at(-1)).toMatchObject({ kind: "completed", success: true, deniedActions: [] });
  });

  it("does not trust status SUCCESS when a command was denied", () => {
    const events = parse(fixture("denied-command.stream.jsonl"));
    expect(events.filter((e) => e.kind === "diagnostic")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_result", tool: "run_command", ok: false }));
    expect(events).toContainEqual({ kind: "permission_denied", tool: "RunCommand", detail: "command" });
    expect(events.at(-1)).toMatchObject({ kind: "completed", success: false, deniedActions: ["RunCommand"] });
  });
});
