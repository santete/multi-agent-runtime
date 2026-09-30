import { GenericCliAdapter } from "@mar/adapter-generic-cli";
import type { AgentEvent } from "@mar/core";
import { describe, expect, it } from "vitest";
import { runAgentProcess } from "../src/process.js";

function node(script: string, opts: { stdin?: boolean } = {}) {
  const adapter = new GenericCliAdapter({
    command: process.execPath,
    args: ["-e", script],
    ...(opts.stdin && { promptViaStdin: true }),
  });
  return {
    spec: adapter.buildCommand({ workspace: process.cwd(), prompt: "PROMPT", permissionProfile: "edit" }),
    parser: adapter.createParser(),
  };
}

describe("runAgentProcess", () => {
  it("streams stdout as messages, stderr as diagnostics and completes on exit 0", async () => {
    const { spec, parser } = node("console.log('one'); console.error('warn'); console.log('two')");
    const events: AgentEvent[] = [];
    const outcome = await runAgentProcess(spec, parser, { onEvent: (e) => events.push(e) });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.terminal).toMatchObject({ kind: "completed", success: true, result: "one\ntwo" });
    expect(events).toContainEqual({ kind: "diagnostic", text: "warn" });
    expect(events.filter((e) => e.kind === "message").map((e) => (e as { text: string }).text)).toEqual(["one", "two"]);
    expect(events.at(-1)).toBe(outcome.terminal);
  });

  it("passes the prompt on stdin", async () => {
    const { spec, parser } = node("process.stdin.on('data', d => process.stdout.write(d + '\\n'))", { stdin: true });
    const outcome = await runAgentProcess(spec, parser, { onEvent: () => undefined });
    expect(outcome.terminal).toMatchObject({ kind: "completed", result: "PROMPT" });
  });

  it("reports non-zero exit as unsuccessful", async () => {
    const { spec, parser } = node("process.exit(3)");
    const outcome = await runAgentProcess(spec, parser, { onEvent: () => undefined });
    expect(outcome).toMatchObject({ exitCode: 3, terminal: { kind: "completed", success: false } });
  });

  it("kills the process on timeout", async () => {
    const { spec, parser } = node("setTimeout(() => {}, 60000)");
    const outcome = await runAgentProcess(spec, parser, { timeoutMs: 300, onEvent: () => undefined });
    expect(outcome.terminal).toEqual({ kind: "failed", reason: "timed out after 300 ms" });
  });

  it("kills the process when cancelled", async () => {
    const { spec, parser } = node("setTimeout(() => {}, 60000)");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const outcome = await runAgentProcess(spec, parser, { signal: ac.signal, onEvent: () => undefined });
    expect(outcome.terminal).toEqual({ kind: "failed", reason: "cancelled" });
  });

  it("reports a missing executable instead of throwing", async () => {
    const adapter = new GenericCliAdapter({ command: "definitely-not-a-real-binary-xyz" });
    const outcome = await runAgentProcess(
      adapter.buildCommand({ workspace: process.cwd(), prompt: "x", permissionProfile: "edit" }),
      adapter.createParser(),
      { onEvent: () => undefined },
    );
    expect(outcome.terminal).toMatchObject({ kind: "failed", reason: expect.stringContaining("failed to start") });
  });
});
