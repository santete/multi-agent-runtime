import type { AgentEvent } from "@mar/core";
import { describe, expect, it } from "vitest";
import { classifyPreflight } from "../src/preflight.js";

const completed = (extra: object = {}) =>
  ({ kind: "completed", sessionId: "s", success: true, deniedActions: [] as string[], result: "v22.18.0", ...extra }) as never;

describe("classifyPreflight", () => {
  it("is ready when the agent ran the command and said its output", () => {
    const events: AgentEvent[] = [{ kind: "tool_result", callId: "1", tool: "shell", ok: true, output: "v22.18.0\n" }];
    expect(classifyPreflight(events, completed())).toEqual({ status: "ready", reason: "" });
  });

  it("finds Antigravity headless: the command was denied and nothing came back", () => {
    const events: AgentEvent[] = [{ kind: "permission_denied", tool: "RunCommand", detail: "command" }];
    const verdict = classifyPreflight(events, completed({ success: false, result: "", deniedActions: ["RunCommand"] }));
    expect(verdict.status).toBe("no_shell");
    expect(verdict.reason).toContain("RunCommand");
  });

  it("finds Qoder without credit: unavailable, with the agent's own words", () => {
    const events: AgentEvent[] = [{ kind: "message", text: "You've reached your credit usage limit. Please upgrade your subscription plan." }];
    const verdict = classifyPreflight(events, completed({ success: false, result: "" }));
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reason).toContain("credit usage limit");
  });

  it("is unavailable when the agent did not run at all", () => {
    expect(classifyPreflight([], { kind: "failed", reason: "failed to start qodercli: ENOENT" })).toMatchObject({ status: "unavailable" });
  });

  it("cannot run commands when the answer has no command output", () => {
    expect(classifyPreflight([{ kind: "message", text: "I cannot run commands here." }], completed({ result: "I cannot run commands here." }))).toMatchObject({
      status: "no_shell",
    });
  });
});
