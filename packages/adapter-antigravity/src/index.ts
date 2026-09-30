import {
  exitWithoutResult,
  hookCommandLine,
  POLICY_HOOK_TIMEOUT_SECONDS,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentOutputParser,
  type AgentRunRequest,
  type CommandSpec,
  type TokenUsage,
  type WorkspaceFile,
} from "@mar/core";

export const AGY_HOOKS_FILE = ".agents/hooks.json";
const AGY_HOOK_NAME = "mar-policy";
const HOOK_ENV_VAR = "MAR_POLICY_HOOK";
/** agy's tool error when a hook denies (or fails): "tool call denied by pre-tool hook: <reason>". */
const HOOK_BLOCKED = /\bhook\b/i;

export interface AntigravityAdapterOptions {
  /** Executable name or absolute path (default install: %LOCALAPPDATA%\agy\bin\agy.exe). */
  executable?: string;
  /** Used when the request has no timeout. agy's own default (0) waits forever. */
  defaultTimeoutSeconds?: number;
  /** Target platform of the runner (for tests); defaults to the current one. */
  platform?: NodeJS.Platform;
}

/**
 * Antigravity CLI (`agy -p --output-format stream-json`).
 * Verified against agy 1.2.13, see docs/spikes/adapter-capability-matrix.md.
 *
 * Policy is enforced by a PreToolUse hook the runner writes to
 * `<workspace>/.agents/hooks.json`. In headless mode a hook "deny" is honoured,
 * but "allow" cannot unlock commands (upstream issues #548/#619), so commands
 * are reported as denied_actions until that is fixed (ADR-0004).
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  readonly capabilities: AdapterCapabilities = {
    pause: "checkpoint",
    resume: true,
    approval: "pre-tool-hook",
    structuredOutput: true,
    streaming: true,
    costReporting: false,
  };

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  buildCommand(request: AgentRunRequest): CommandSpec {
    const timeout = request.timeoutSeconds ?? this.options.defaultTimeoutSeconds ?? 1800;
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--print-timeout",
      `${timeout}s`,
      "--disable-slash-commands",
      "--mode",
      request.permissionProfile === "read-only" ? "plan" : "accept-edits",
    ];
    if (request.resumeSessionId) args.push("--conversation", request.resumeSessionId);
    if (request.model) args.push("--model", request.model);
    if (request.outputSchema) args.push("--json-schema", JSON.stringify(request.outputSchema));

    const env = {
      ...request.env,
      ...(request.policyHook && this.windows && { [HOOK_ENV_VAR]: hookCommandLine(request.policyHook, "agy") }),
    };
    return {
      command: this.options.executable ?? "agy",
      args,
      cwd: request.workspace,
      ...(Object.keys(env).length > 0 && { env }),
    };
  }

  /**
   * agy reads hooks from the workspace, so the policy hook is a file merged
   * under its own name.
   *
   * On Windows agy runs hook commands via `cmd /c` with their quotes escaped
   * as `\"`, which breaks any quoted path (e.g. under Program Files). There the
   * hook command is the quote-free `%MAR_POLICY_HOOK%`: cmd expands the
   * variable (set in the agent's environment) before parsing, so the quotes
   * inside its value survive. Verified against agy 1.2.13.
   */
  workspaceFiles(request: AgentRunRequest): WorkspaceFile[] {
    if (!request.policyHook) return [];
    const command = this.windows ? `%${HOOK_ENV_VAR}%` : hookCommandLine(request.policyHook, "agy");
    return [
      {
        path: AGY_HOOKS_FILE,
        mergeJson: true,
        content: {
          [AGY_HOOK_NAME]: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: POLICY_HOOK_TIMEOUT_SECONDS }] }],
          },
        },
      },
    ];
  }

  private get windows(): boolean {
    return (this.options.platform ?? process.platform) === "win32";
  }

  createParser(): AgentOutputParser {
    return new AntigravityStreamParser();
  }
}

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
}

function toUsage(u: AgyUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.cache_read_tokens !== undefined && { cacheReadTokens: u.cache_read_tokens }),
    ...(u.thinking_tokens !== undefined && { thinkingTokens: u.thinking_tokens }),
  };
}

export class AntigravityStreamParser implements AgentOutputParser {
  private sessionId: string | undefined;
  private terminated = false;
  /** agent_response text arrives as deltas per step; flushed when the step is DONE. */
  private readonly textByStep = new Map<number, string>();
  private readonly hookDenials: string[] = [];

  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // agy writes human-readable diagnostics (e.g. "jetski: no output produced ...").
      return [{ kind: "diagnostic", text: trimmed }];
    }

    switch (msg.event) {
      case "init":
        this.sessionId = msg.conversation_id;
        return [{ kind: "session_started", sessionId: msg.conversation_id }];
      case "step_update":
        return this.step(msg.step_update ?? {});
      case "result":
        return this.result(msg.result ?? {});
      default:
        return [];
    }
  }

  private step(s: Record<string, any>): AgentEvent[] {
    const idx: number = s.step_index;
    if (s.step_type === "agent_response") {
      const events: AgentEvent[] = [];
      if (typeof s.text_delta === "string") {
        this.textByStep.set(idx, (this.textByStep.get(idx) ?? "") + s.text_delta);
      }
      if (s.state === "DONE") {
        const text = this.textByStep.get(idx);
        this.textByStep.delete(idx);
        if (text) events.push({ kind: "message", text });
        const usage = toUsage(s.usage);
        if (usage) events.push({ kind: "usage", usage });
      }
      return events;
    }

    if (s.step_type === "tool") {
      const callId = String(idx);
      const tool: string = s.tool_name ?? s.tool_info?.name ?? "unknown";
      if (s.state === "ACTIVE") {
        return [{ kind: "tool_call", callId, tool, input: s.tool_info?.parameters }];
      }
      if (s.state === "DONE") return [{ kind: "tool_result", callId, tool, ok: true }];
      if (s.state === "ERROR") {
        const message: string | undefined = s.tool_info?.error?.message;
        const events: AgentEvent[] = [
          { kind: "tool_result", callId, tool, ok: false, ...(message && { output: message }) },
        ];
        // Blocked by (or failure of) the PreToolUse hook: agy does not list
        // these in denied_actions, so record them here.
        if (message && HOOK_BLOCKED.test(message)) {
          this.hookDenials.push(tool);
          events.push({ kind: "permission_denied", tool, detail: message });
        }
        return events;
      }
    }
    return [];
  }

  finish(exitCode: number | null): AgentEvent[] {
    return this.terminated ? [] : [exitWithoutResult(exitCode, this.sessionId)];
  }

  private result(r: Record<string, any>): AgentEvent[] {
    this.terminated = true;
    const denied: Array<{ action?: string; display_name?: string }> = Array.isArray(r.denied_actions)
      ? r.denied_actions
      : [];
    const deniedActions = [...denied.map((d) => d.display_name ?? d.action ?? "unknown"), ...this.hookDenials];
    const events: AgentEvent[] = denied.map((d) => ({
      kind: "permission_denied",
      tool: d.display_name ?? d.action ?? "unknown",
      ...(d.action && { detail: d.action }),
    }));
    const usage = toUsage(r.usage);
    events.push({
      kind: "completed",
      sessionId: r.conversation_id ?? this.sessionId ?? "",
      result: r.structured_output ?? r.response,
      // agy reports SUCCESS even when every tool call was denied.
      success: r.status === "SUCCESS" && deniedActions.length === 0,
      deniedActions,
      ...(typeof r.duration_seconds === "number" && { durationMs: Math.round(r.duration_seconds * 1000) }),
      ...(usage && { usage }),
    });
    return events;
  }
}
