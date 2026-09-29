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
      prompt: "Write tests",
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
