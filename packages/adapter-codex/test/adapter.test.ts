import { readFileSync } from "node:fs";
import type { AgentEvent } from "@mar/core";
import { describe, expect, it } from "vitest";
import { CODEX_SCHEMA_FILE, CodexAdapter } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

function parse(lines: string[]): AgentEvent[] {
  const parser = new CodexAdapter().createParser();
  return lines.flatMap((l) => parser.push(l));
}

const base = { workspace: "C:\\ws\\PAY-1", prompt: "Do it", objective: "Do it", permissionProfile: "edit" as const };

describe("CodexAdapter.buildCommand", () => {
  it("runs codex exec hermetically in its workspace-write sandbox with the prompt on stdin", () => {
    const cmd = new CodexAdapter({ platform: "win32" }).buildCommand(base);
    expect(cmd.command).toBe("codex");
    expect(cmd.cwd).toBe("C:\\ws\\PAY-1");
    expect(cmd.stdin).toBe("Do it");
    expect(cmd.args).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-c",
      'windows.sandbox="elevated"',
      "-",
    ]);
  });

  it("does not select the Windows sandbox elsewhere and uses read-only for analysis tasks", () => {
    const cmd = new CodexAdapter({ platform: "linux" }).buildCommand({ ...base, permissionProfile: "read-only" });
    expect(cmd.args).toContain('sandbox_mode="read-only"');
    expect(cmd.args.join(" ")).not.toContain("windows.sandbox");
  });

  it("resumes a session, sets the model, the output schema and the policy hook", () => {
    const cmd = new CodexAdapter({ platform: "win32" }).buildCommand({
      ...base,
      resumeSessionId: "thread-1",
      model: "gpt-5.5",
      outputSchema: { type: "object" },
      policyHook: { command: "node", args: ["/hook.mjs"] },
      env: { MAR_EXECUTION_ID: "e1" },
    });
    expect(cmd.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    const joined = cmd.args.join(" ");
    expect(joined).toContain('model="gpt-5.5"');
    expect(joined).toContain(`--output-schema ${CODEX_SCHEMA_FILE}`);
    expect(joined).toContain('projects."C:\\\\ws\\\\PAY-1".trust_level="trusted"');
    expect(joined).toContain("--dangerously-bypass-hook-trust");
    expect(cmd.args.at(-1)).toBe("-");
    expect(cmd.env).toEqual({ MAR_EXECUTION_ID: "e1" });
  });

  it("writes the schema file and a regex-matched hooks.json into the workspace", () => {
    const files = new CodexAdapter().workspaceFiles({
      ...base,
      outputSchema: { type: "object" },
      policyHook: { command: "node", args: ["/hook.mjs"] },
    });
    expect(files).toEqual([
      { path: CODEX_SCHEMA_FILE, content: { type: "object" }, mergeJson: false },
      {
        path: ".codex/hooks.json",
        mergeJson: true,
        content: {
          hooks: {
            PreToolUse: [
              { matcher: ".*", hooks: [{ type: "command", command: '"node" "/hook.mjs" "claude"', timeout: 120 }] },
            ],
          },
        },
      },
    ]);
    expect(new CodexAdapter().workspaceFiles(base)).toEqual([]);
  });

  it("declares sandbox-based approval (no PreToolUse on Windows, openai/codex#24453)", () => {
    expect(new CodexAdapter().capabilities).toMatchObject({ approval: "sandbox", resume: true, structuredOutput: true });
  });
});

describe("CodexStreamParser (recorded codex-cli 0.159.2 runs)", () => {
  it("maps commands and file changes to tool calls and results", () => {
    const events = parse(fixture("edit-and-commands.jsonl"));
    expect(events[0]).toEqual({ kind: "session_started", sessionId: "01a0f20f-2a0c-7e32-8ff4-6eae23368683" });
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "tool_call")).toHaveLength(3);
    expect(kinds.filter((k) => k === "tool_result")).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool_call", tool: "apply_patch", input: expect.objectContaining({ paths: ["C:\\work\\ws\\README.md"] }) }),
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_result", tool: "shell", ok: true, output: "# x\r\n" }));
    // The curl call failed (no network in the sandbox / PowerShell alias).
    expect(events.filter((e) => e.kind === "tool_result" && !e.ok)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "completed", success: true, usage: { inputTokens: 55767, outputTokens: 308 } });
  });

  it("parses the schema-constrained final message as the structured result", () => {
    const done = parse(fixture("structured-output.jsonl")).at(-1);
    expect(done).toMatchObject({
      kind: "completed",
      result: { summary: "Created `hello.txt` containing `hi`.", changes: [expect.stringContaining("?? hello.txt")] },
    });
  });

  it("reports failed turns, stray output and processes that exit without a result", () => {
    const parser = new CodexAdapter().createParser();
    parser.push(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
    expect(parser.push("Reading additional input from stdin...")).toEqual([
      { kind: "diagnostic", text: "Reading additional input from stdin..." },
    ]);
    expect(parser.push(JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } }))).toEqual([
      { kind: "failed", sessionId: "t1", reason: "quota exceeded" },
    ]);
    expect(parser.finish(1)).toEqual([]);
    expect(new CodexAdapter().createParser().finish(2)).toEqual([
      { kind: "failed", reason: "process exited with code 2 without a result" },
    ]);
  });
});
