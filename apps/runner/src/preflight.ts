import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentAdapter, type AgentEvent, type AgentHealthStatus, type AgentRunRequest, isAgentUnavailable, type WorkspaceFile } from "@mar/core";
import { type ProcessOutcome, runAgentProcess } from "./process.js";

/**
 * A small task every agent must be able to do before real work is handed to it: run one shell command and
 * report its output. Seen live: Codex could not run `pnpm`, Antigravity (headless) could not run any command,
 * Qoder had no credit left. Each of them took a task, burned the attempts and handed it back.
 */
export const PREFLIGHT_PROMPT =
  "Preflight check. Run the shell command `node -v` and reply with exactly the version it printed, and nothing else. Do not edit any file.";

/** Allows `node -v` and nothing else; what lets hook-gated agents run the preflight command. */
export const PREFLIGHT_HOOK_SCRIPT = fileURLToPath(new URL("../hook/mar-preflight-hook.mjs", import.meta.url));

export interface PreflightVerdict {
  status: AgentHealthStatus;
  reason: string;
}

const VERSION = /\bv\d+\.\d+\.\d+/;

const textOf = (terminal: ProcessOutcome["terminal"]): string => {
  if (terminal.kind === "failed") return terminal.reason;
  return typeof terminal.result === "string" ? terminal.result : terminal.result ? JSON.stringify(terminal.result) : "";
};

/** What a preflight run says about the agent, from the events it produced and its terminal event. */
export function classifyPreflight(events: AgentEvent[], terminal: ProcessOutcome["terminal"]): PreflightVerdict {
  const lastMessage = [...events].reverse().find((e) => e.kind === "message" && e.text.trim());
  const said = [textOf(terminal), lastMessage?.kind === "message" ? lastMessage.text : ""].filter(Boolean).join("\n").trim();
  if (terminal.kind === "failed") return { status: "unavailable", reason: `did not run: ${said.slice(0, 300)}` };
  if (!terminal.success && isAgentUnavailable(said)) return { status: "unavailable", reason: said.slice(0, 300) };

  const denied = [...terminal.deniedActions, ...events.flatMap((e) => (e.kind === "permission_denied" ? [e.tool] : []))];
  const ranCommand = events.some((e) => e.kind === "tool_result" && e.ok && VERSION.test(e.output ?? "")) || VERSION.test(said);
  if (ranCommand && !denied.length) return { status: "ready", reason: "" };
  if (denied.length) return { status: "no_shell", reason: `commands are denied in headless mode (${[...new Set(denied)].join(", ")})` };
  return { status: "no_shell", reason: `could not run a command: ${said.slice(0, 200) || "no answer"}` };
}

export interface ProbeOptions {
  /** Runner home: the probe works in `<home>/preflight/<agent>`. */
  home: string;
  timeoutSeconds: number;
  signal?: AbortSignal | undefined;
}

/** Runs the preflight task with the agent and classifies the result. Never throws. */
export async function probeAgent(adapter: AgentAdapter, agentId: string, options: ProbeOptions): Promise<PreflightVerdict> {
  const workspace = join(options.home, "preflight", agentId.replace(/[^\w.-]/g, "_"));
  try {
    mkdirSync(workspace, { recursive: true });
    // Some CLIs refuse to work outside a git repository.
    if (!existsSync(join(workspace, ".git"))) execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
    const events: AgentEvent[] = [];
    const request: AgentRunRequest = {
      workspace,
      prompt: PREFLIGHT_PROMPT,
      objective: PREFLIGHT_PROMPT,
      permissionProfile: "edit",
      timeoutSeconds: options.timeoutSeconds,
      // As in real runs: these agents only run commands when their hook allows them.
      ...(adapter.capabilities.approval === "pre-tool-hook" && { policyHook: { command: process.execPath, args: [PREFLIGHT_HOOK_SCRIPT] } }),
    };
    for (const file of adapter.workspaceFiles?.(request) ?? []) writeWorkspaceFile(workspace, file);
    const outcome = await runAgentProcess(
      adapter.buildCommand(request),
      adapter.createParser(),
      { timeoutMs: options.timeoutSeconds * 1000, ...(options.signal && { signal: options.signal }), onEvent: (e) => events.push(e) },
    );
    return classifyPreflight(events, outcome.terminal);
  } catch (err) {
    return { status: "unavailable", reason: `preflight crashed: ${String(err).slice(0, 300)}` };
  }
}

function writeWorkspaceFile(workspace: string, file: WorkspaceFile): void {
  const full = join(workspace, ...file.path.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  if (typeof file.content === "string") return writeFileSync(full, file.content);
  const existing = file.mergeJson && existsSync(full) ? (JSON.parse(readFileSync(full, "utf8")) as object) : {};
  writeFileSync(full, JSON.stringify({ ...existing, ...file.content }, null, 2) + "\n");
}
