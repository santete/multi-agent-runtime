import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mar/core";
import { QODER_READ_ONLY_TOOLS, QODER_SETTINGS_FILE, QoderAdapter } from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

function parse(lines: string[]): AgentEvent[] {
  const parser = new QoderAdapter().createParser();
  return [...lines.flatMap((l) => parser.push(l)), ...parser.finish(0)];
}

const result = (text: string, extra: object = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0, session_id: "s1", ...extra });

describe("QoderAdapter.buildCommand", () => {
  it("builds an isolated headless command with the prompt on stdin", () => {
    const cmd = new QoderAdapter().buildCommand({
      workspace: "/ws/TASK-1",
      prompt: "Implement the refund API",
      objective: "Implement the refund API",
      permissionProfile: "edit",
      resumeSessionId: "abc",
      model: "performance",
      env: { MAR_EXECUTION_ID: "e1" },
    });
    expect(cmd.command).toBe("qodercli");
    expect(cmd.cwd).toBe("/ws/TASK-1");
    expect(cmd.stdin).toBe("Implement the refund API");
    expect(cmd.env).toEqual({ MAR_EXECUTION_ID: "e1" });
    const joined = cmd.args.join(" ");
    expect(joined).toContain("-p --output-format stream-json --setting-sources project,local --strict-mcp-config");
    expect(joined).toContain("--permission-mode accept_edits");
    expect(joined).toContain("--resume abc");
    expect(joined).toContain("--model performance");
    const tools = cmd.args[cmd.args.indexOf("--tools") + 1]!.split(",");
    expect(tools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(tools).not.toContain("CronCreate");
    expect(tools).not.toContain("EnterWorktree");
    expect(cmd.args).not.toContain("--append-system-prompt");
  });

  it("gives read-only runs no tool that writes or runs commands", () => {
    const cmd = new QoderAdapter().buildCommand({ workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "read-only" });
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(cmd.args[cmd.args.indexOf("--tools") + 1]).toBe(QODER_READ_ONLY_TOOLS.join(","));
  });

  it("asks for the output schema in the system prompt", () => {
    const cmd = new QoderAdapter().buildCommand({
      workspace: "/ws",
      prompt: "x",
      objective: "x",
      permissionProfile: "edit",
      outputSchema: { type: "object", required: ["summary"] },
    });
    const extra = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1]!;
    expect(extra).toContain("only a JSON object");
    expect(extra).toContain('{"type":"object","required":["summary"]}');
  });

  it("uses a configured executable and tool list", () => {
    const cmd = new QoderAdapter({ executable: "C:/q/qodercli.exe", tools: ["Read", "Bash"] }).buildCommand({
      workspace: "/ws",
      prompt: "x",
      objective: "x",
      permissionProfile: "edit",
    });
    expect(cmd.command).toBe("C:/q/qodercli.exe");
    expect(cmd.args[cmd.args.indexOf("--tools") + 1]).toBe("Read,Bash");
  });
});

describe("QoderAdapter.workspaceFiles", () => {
  it("installs the policy hook into the workspace's local settings", () => {
    const files = new QoderAdapter().workspaceFiles({
      workspace: "/ws",
      prompt: "x",
      objective: "x",
      permissionProfile: "edit",
      policyHook: { command: "node", args: ["/hook.mjs"] },
    });
    expect(files).toEqual([
      {
        path: QODER_SETTINGS_FILE,
        mergeJson: true,
        content: {
          hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: '"node" "/hook.mjs" "claude"', timeout: 120 }] }] },
        },
      },
    ]);
  });

  it("writes nothing without a policy hook", () => {
    expect(new QoderAdapter().workspaceFiles({ workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "edit" })).toEqual([]);
  });
});

describe("QoderStreamParser", () => {
  it("reads the Claude-style stream and reports calls denied by the hook or a permission prompt", () => {
    const events = parse(fixture("hook-denied.stream.jsonl"));
    expect(events[0]).toEqual({ kind: "session_started", sessionId: "74c2df91-dc43-44c1-ad99-d16ff0b3dcb8", model: "Efficient" });
    expect(events.filter((e) => e.kind === "tool_call").map((e) => e.kind === "tool_call" && e.tool)).toEqual(["Write", "Bash"]);
    expect(events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "Bash", detail: "[HIGH] command needs approval: node -e" },
      { kind: "permission_denied", tool: "unknown", detail: "Allow Bash to run: rm -rf build?" },
    ]);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ kind: "completed", success: false, deniedActions: ["Bash", "unknown"], durationMs: 9120 });
    // Credits only: no zero cost or zero token usage.
    expect(done).not.toHaveProperty("costUsd");
    expect(done).not.toHaveProperty("usage");
  });

  it("parses the structured answer from the final text", () => {
    const answer = { summary: "Added the endpoint", changes: ["api.ts"] };
    for (const text of [JSON.stringify(answer), "Done.\n```json\n" + JSON.stringify(answer) + "\n```"]) {
      const done = parse([result(text)]).at(-1)!;
      expect(done).toMatchObject({ kind: "completed", success: true, result: answer, deniedActions: [] });
    }
  });

  it("keeps a plain text answer", () => {
    expect(parse([result("All done, no JSON here.")]).at(-1)).toMatchObject({ kind: "completed", result: "All done, no JSON here." });
  });

  it("keeps real token usage when reported", () => {
    const done = parse([result("ok", { usage: { input_tokens: 10, output_tokens: 5 } })]).at(-1)!;
    expect(done).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("reports a run that ended without a result", () => {
    const parser = new QoderAdapter().createParser();
    parser.push(JSON.stringify({ type: "system", subtype: "init", session_id: "s9" }));
    expect(parser.finish(1)).toMatchObject([{ kind: "failed", sessionId: "s9" }]);
  });
});
