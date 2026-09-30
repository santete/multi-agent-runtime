import { describe, expect, it } from "vitest";
import { GenericCliAdapter } from "../src/index.js";

describe("GenericCliAdapter", () => {
  it("substitutes the prompt into configured args", () => {
    const cmd = new GenericCliAdapter({ command: "bash", args: ["-c", "echo {prompt}"] }).buildCommand({
      workspace: "/ws",
      prompt: "hello",
      permissionProfile: "edit",
    });
    expect(cmd).toEqual({ command: "bash", args: ["-c", "echo hello"], cwd: "/ws" });
  });

  it("can deliver the prompt on stdin", () => {
    const cmd = new GenericCliAdapter({ command: "cat", args: [], promptViaStdin: true }).buildCommand({
      workspace: "/ws",
      prompt: "hello",
      permissionProfile: "edit",
    });
    expect(cmd.stdin).toBe("hello");
    expect(cmd.args).toEqual([]);
  });

  it("maps stdout lines to messages and the exit code to success", () => {
    const parser = new GenericCliAdapter({ command: "x" }).createParser();
    expect(parser.push("line 1\r")).toEqual([{ kind: "message", text: "line 1" }]);
    expect(parser.push("  ")).toEqual([]);
    parser.push("line 2");
    expect(parser.finish(0)).toEqual([
      { kind: "completed", sessionId: "", result: "line 1\nline 2", success: true, deniedActions: [] },
    ]);
  });

  it("reports failure for non-zero exit and for killed processes", () => {
    expect(new GenericCliAdapter({ command: "x" }).createParser().finish(2)).toEqual([
      expect.objectContaining({ kind: "completed", success: false }),
    ]);
    expect(new GenericCliAdapter({ command: "x" }).createParser().finish(null)).toEqual([
      { kind: "failed", reason: "process was killed" },
    ]);
  });
});
