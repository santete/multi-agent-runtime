import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunRequest } from "@mar/core";
import type { ProcessOutcome } from "../src/process.js";
import { mergeRepair, repairPrompt, unreadableStructuredResult } from "../src/repair.js";

const adapter = { capabilities: { resume: true, promptedSchema: true } } as AgentAdapter;
const request = { workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "edit", outputSchema: { type: "object" } } as AgentRunRequest;

const completed = (result: unknown, extra: object = {}): ProcessOutcome => ({
  exitCode: 0,
  terminal: { kind: "completed", sessionId: "s1", result, success: true, deniedActions: [], ...extra },
});

describe("unreadableStructuredResult", () => {
  it("finds broken JSON in an answer that should be structured", () => {
    // A missing comma: closing brackets that were left out are added when parsing, this cannot be.
    const broken = '{"summary":"x" "tasks":[]}';
    expect(unreadableStructuredResult(request, completed(broken), adapter)).toEqual({
      sessionId: "s1",
      error: expect.stringMatching(/JSON/),
    });
    expect(unreadableStructuredResult(request, completed("All done."), adapter)?.error).toBe("the answer contains no JSON object");
    expect(unreadableStructuredResult(request, completed(""), adapter)?.error).toBe("the answer was empty");
  });

  it("finds an answer without the schema's required fields, such as the schema itself", () => {
    const schemaRequest = { ...request, outputSchema: { type: "object", required: ["summary", "tasks"], properties: {} } };
    const echoed = { type: "object", required: ["summary", "tasks"], properties: {} };
    expect(unreadableStructuredResult(schemaRequest, completed(echoed), adapter)?.error).toBe(
      "required fields are missing: summary, tasks (send the answer itself, not the schema)",
    );
    expect(unreadableStructuredResult(schemaRequest, completed(JSON.stringify({ summary: "x" })), adapter)?.error).toMatch(/missing: tasks/);
    expect(unreadableStructuredResult(schemaRequest, completed({ summary: "x", tasks: [] }), adapter)).toBeUndefined();
    // A repair that still lacks them is not taken.
    const first = completed(echoed);
    expect(mergeRepair(first, completed({ summary: "x" }), schemaRequest.outputSchema)).toBe(first);
    expect(mergeRepair(first, completed({ summary: "x", tasks: [] }), schemaRequest.outputSchema).terminal).toMatchObject({ result: { summary: "x", tasks: [] } });
  });

  it("leaves readable, unstructured, failed or unresumable runs alone", () => {
    expect(unreadableStructuredResult(request, completed({ summary: "x" }), adapter)).toBeUndefined();
    expect(unreadableStructuredResult(request, completed('Done:\n```json\n{"summary":"x"}\n```'), adapter)).toBeUndefined();
    expect(unreadableStructuredResult({ workspace: "/ws", prompt: "x", objective: "x", permissionProfile: "edit" }, completed("text"), adapter)).toBeUndefined();
    expect(unreadableStructuredResult(request, { exitCode: 1, terminal: { kind: "failed", reason: "x" } }, adapter)).toBeUndefined();
    expect(unreadableStructuredResult(request, completed("text"), { capabilities: { resume: false, promptedSchema: true } } as AgentAdapter)).toBeUndefined();
    // A CLI that enforces the schema (Claude, agy, Codex) is not asked again.
    expect(unreadableStructuredResult(request, completed("text"), { capabilities: { resume: true } } as AgentAdapter)).toBeUndefined();
    expect(unreadableStructuredResult(request, completed("text", { sessionId: "" }), adapter)).toBeUndefined();
  });
});

describe("mergeRepair", () => {
  const first = completed("{broken", { usage: { inputTokens: 100, outputTokens: 10 }, durationMs: 1000 });

  it("takes the repaired answer and adds up usage", () => {
    const merged = mergeRepair(first, completed('{"summary":"fixed"}', { usage: { inputTokens: 5, outputTokens: 2 }, durationMs: 200 }));
    expect(merged.terminal).toMatchObject({
      kind: "completed",
      sessionId: "s1",
      result: { summary: "fixed" },
      success: true,
      usage: { inputTokens: 105, outputTokens: 12 },
      durationMs: 1200,
    });
  });

  it("keeps denied calls of either run", () => {
    const denied = mergeRepair(completed("{broken", { success: false, deniedActions: ["Bash"] }), completed({ summary: "ok" }));
    expect(denied.terminal).toMatchObject({ success: false, deniedActions: ["Bash"], result: { summary: "ok" } });
  });

  it("keeps the first run when the repair did not help", () => {
    expect(mergeRepair(first, completed("still broken"))).toBe(first);
    expect(mergeRepair(first, { exitCode: 1, terminal: { kind: "failed", reason: "quota" } })).toBe(first);
  });

  it("tells the agent what was wrong", () => {
    expect(repairPrompt("Unexpected end of JSON input")).toMatch(/^Your final answer could not be read as JSON: Unexpected end of JSON input\. Reply now with only the corrected JSON object/);
  });
});
