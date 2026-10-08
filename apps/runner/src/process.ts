import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentOutputParser, CommandSpec } from "@mar/core";
import { type ResolvedCommand, resolveCommand } from "./resolve.js";

/**
 * Agents spawn their own children (tool shells, hooks). On Windows,
 * `child.kill()` only ends the top process, so kill the whole tree.
 */
export function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform !== "win32" || pid === undefined) return fallback();
  const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  killer.on("error", fallback);
}

export interface ProcessOutcome {
  exitCode: number | null;
  terminal: Extract<AgentEvent, { kind: "completed" | "failed" }>;
}

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

/**
 * An unsuccessful run that carries no error text gets the agent's last message
 * as its result, so "You've reached your credit usage limit" is seen as the
 * agent being unavailable (cooldown, other agent) and not as a failed task.
 */
export function withFailureText(e: ProcessOutcome["terminal"], lastMessage: string): ProcessOutcome["terminal"] {
  if (e.kind !== "completed" || e.success || !lastMessage) return e;
  if (typeof e.result === "string" ? e.result.trim() : e.result) return e;
  return { ...e, result: lastMessage.slice(0, 2000) };
}

const isTerminal = (e: AgentEvent): e is ProcessOutcome["terminal"] => e.kind === "completed" || e.kind === "failed";

/**
 * Spawns an adapter command, feeds stdout to the adapter parser line by line
 * and stderr as diagnostics. Always resolves with exactly one terminal event.
 */
export function runAgentProcess(
  spec: CommandSpec,
  parser: AgentOutputParser,
  opts: RunProcessOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let terminal: ProcessOutcome["terminal"] | undefined;
    // Some CLIs (Qoder) say why a run failed in a message and end with a bare "completed, not successful".
    let lastMessage = "";
    const emit = (events: AgentEvent[]) => {
      for (const e of events) {
        if (e.kind === "message" && typeof e.text === "string" && e.text.trim()) lastMessage = e.text.trim();
        const event = isTerminal(e) ? withFailureText(e, lastMessage) : e;
        if (isTerminal(event)) terminal ??= event;
        opts.onEvent(event);
      }
    };

    const failBeforeStart = (reason: string) => {
      const failed: ProcessOutcome["terminal"] = { kind: "failed", reason };
      opts.onEvent(failed);
      resolve({ exitCode: null, terminal: failed });
    };
    // Cancelled while the workspace was being prepared: an "abort" listener
    // added now would never fire, so do not start the agent at all.
    if (opts.signal?.aborted) return failBeforeStart("cancelled");

    const env = { ...process.env, ...spec.env };
    let resolved: ResolvedCommand;
    try {
      resolved = resolveCommand(spec.command, env);
    } catch (err) {
      return failBeforeStart((err as Error).message);
    }

    const child = spawn(resolved.command, [...resolved.prefixArgs, ...spec.args], {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let killedReason: string | undefined;
    const kill = (reason: string) => {
      if (child.exitCode !== null || killedReason) return;
      killedReason = reason;
      killTree(child.pid, () => child.kill());
    };
    const timer = opts.timeoutMs ? setTimeout(() => kill(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs) : undefined;
    const onAbort = () => kill("cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => emit(parser.push(line)));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (line.trim()) emit([{ kind: "diagnostic", text: line }]);
    });

    child.stdin.on("error", () => undefined); // process may exit before reading stdin
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();

    let settled = false;
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) {
        emit([{ kind: "failed", reason: `failed to start ${spec.command}: ${spawnError.message}` }]);
      } else if (killedReason) {
        emit([{ kind: "failed", reason: killedReason }]);
      } else {
        emit(parser.finish(exitCode));
      }
      resolve({ exitCode, terminal: terminal ?? { kind: "failed", reason: "no terminal event" } });
    };

    child.on("error", (err) => finish(null, err));
    // "close" fires after stdio streams end, so every line has been parsed.
    child.on("close", (code) => finish(code));
  });
}
