import {
  exitWithoutResult,
  hookCommandLine,
  parseJsonAnswer,
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

export const COMMAND_CODE_SETTINGS_FILE = ".commandcode/settings.local.json";

/** What Command Code appends to a hook's reason when it blocks a call. */
const BLOCK_SUFFIX = /\n\n\(Blocked by hook policy[\s\S]*$/;
/** Print mode refusing a write or command because permissions are not bypassed. */
const PRINT_MODE_REFUSAL = /requires permissions\. Use --yolo/;

export interface CommandCodeAdapterOptions {
  /**
   * Executable name or absolute path. The npm package installs `cmd`, `cmdc`,
   * `command-code` and `commandcode`; `cmd` is cmd.exe on Windows, so the
   * default is `command-code`.
   */
  executable?: string;
}

/**
 * Command Code CLI (`command-code -p --output-format json`). Verified against
 * Command Code 1.5.0, see docs/spikes/adapter-capability-matrix.md and ADR-0036.
 *
 * - Print mode refuses file writes and shell commands unless permissions are
 *   bypassed (`--yolo`), whatever the permission mode or hook says. Edit runs
 *   therefore use `--yolo`, but only together with the platform policy hook,
 *   which then decides every call. The hook is `failClosed`: by default
 *   Command Code runs the tool when a hook crashes or times out.
 * - The hook and `tasteLearning: false` (no learning from orchestrated runs)
 *   go into the workspace's `.commandcode/settings.local.json`.
 * - Read-only runs use plan mode, which offers only reading tools.
 * - No --json-schema: the schema is appended to the prompt and the final text
 *   parsed as JSON.
 */
export class CommandCodeAdapter implements AgentAdapter {
  readonly id = "command-code";
  readonly capabilities: AdapterCapabilities = {
    pause: "checkpoint",
    resume: true,
    approval: "pre-tool-hook",
    structuredOutput: true,
    promptedSchema: true,
    streaming: true,
    costReporting: false,
  };

  constructor(private readonly options: CommandCodeAdapterOptions = {}) {}

  buildCommand(request: AgentRunRequest): CommandSpec {
    const readOnly = request.permissionProfile === "read-only";
    const args = ["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update"];
    if (readOnly) args.push("--permission-mode", "plan");
    else if (request.policyHook) args.push("--yolo");
    else args.push("--permission-mode", "auto-accept");
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    if (request.model) args.push("--model", request.model);
    const schema = request.outputSchema
      ? "\n\nYour final message must be only a JSON object that validates against this JSON schema (your answer, not the schema itself), " +
        `with no other text and no code fence:\n${JSON.stringify(request.outputSchema)}\n`
      : "";
    const env = request.policyHook && request.env ? { ...request.env, ...hookContext(request.env) } : request.env;
    return {
      command: this.options.executable ?? "command-code",
      args,
      cwd: request.workspace,
      stdin: request.prompt + schema,
      ...(env && { env }),
    };
  }

  workspaceFiles(request: AgentRunRequest): WorkspaceFile[] {
    const hook = request.policyHook && {
      type: "command",
      command: hookCommandLine(request.policyHook, "claude"),
      timeout: POLICY_HOOK_TIMEOUT_SECONDS,
      failClosed: true,
    };
    return [
      {
        path: COMMAND_CODE_SETTINGS_FILE,
        mergeJson: true,
        content: { tasteLearning: false, ...(hook && { hooks: { PreToolUse: [{ matcher: "*", hooks: [hook] }] } }) },
      },
    ];
  }

  createParser(): AgentOutputParser {
    return new CommandCodeStreamParser();
  }
}

/**
 * Command Code removes variables named like credentials (…TOKEN, …SECRET,
 * …API_KEY, …PASSWORD, …AUTH…) from its hooks' environment, which would take
 * the execution token and the project secrets away from the policy hook (it
 * then denies every call, and could not spot a call carrying a secret). They
 * are passed again in MAR_HOOK_CONTEXT, which the hook reads. The agent already
 * has every one of them in its own environment.
 */
const HOOK_ENV_FILTERED = [/API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /OAUTH/i, /CREDENTIAL/i, /PRIVATE_KEY/i, /(^|_)AUTH(_|$)/i, /(^|_)AUTHORIZATION(_|$)/i, /(^|_)BEARER(_|$)/i, /AWS_/i, /ANTHROPIC_/i, /COMMANDCODE_API/i];

export function hookContext(env: Record<string, string>): { MAR_HOOK_CONTEXT?: string } {
  const filtered = Object.fromEntries(Object.entries(env).filter(([name]) => HOOK_ENV_FILTERED.some((p) => p.test(name))));
  return Object.keys(filtered).length ? { MAR_HOOK_CONTEXT: JSON.stringify(filtered) } : {};
}

interface CommandCodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function toUsage(u: CommandCodeUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    ...(u.cacheReadTokens !== undefined && { cacheReadTokens: u.cacheReadTokens }),
  };
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? undefined : JSON.stringify(content);
  return content.map((c: { text?: string }) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n");
};

export class CommandCodeStreamParser implements AgentOutputParser {
  private sessionId: string | undefined;
  private terminated = false;
  private readonly denied: string[] = [];

  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [{ kind: "diagnostic", text: trimmed }];
    }
    if (msg.type === "result") return this.result(msg);
    if (msg.type !== "event" || !msg.event) return [];
    return this.event(msg.event);
  }

  private event(e: Record<string, any>): AgentEvent[] {
    switch (e.type) {
      case "run_start":
        this.sessionId = e.sessionId;
        return [{ kind: "session_started", sessionId: e.sessionId }];
      case "message_end": {
        const content: Array<{ type?: string; text?: string }> = Array.isArray(e.content) ? e.content : [];
        return content.filter((b) => b.type === "text" && b.text).map((b) => ({ kind: "message", text: b.text! }));
      }
      case "tool_queued":
        return [{ kind: "tool_call", callId: e.toolCallId, tool: e.toolName, input: e.input }];
      case "tool_completed": {
        const output = textOf(e.result);
        return [{ kind: "tool_result", callId: e.toolCallId, tool: e.toolName, ok: true, ...(output !== undefined && { output }) }];
      }
      case "tool_errored": {
        const output = textOf(e.error);
        return [{ kind: "tool_result", callId: e.toolCallId, tool: e.toolName, ok: false, ...(output !== undefined && { output }) }];
      }
      case "tool_denied":
        // Command Code's own permission check (plan mode, or no --yolo), never the policy hook: expected
        // in read-only runs. A failed call the agent works around, not a decision waiting for a person.
        return [{ kind: "tool_result", callId: e.toolCallId, tool: e.toolName, ok: false, output: "not permitted in this mode" }];
      case "tool_hook_blocked": {
        const detail = typeof e.hookOutput === "string" ? e.hookOutput.replace(BLOCK_SUFFIX, "").trim() : "blocked";
        // Print mode's own check (no --yolo) is reported the same way: also not a policy decision.
        if (PRINT_MODE_REFUSAL.test(detail)) {
          return [{ kind: "tool_result", callId: e.toolCallId, tool: e.toolName, ok: false, output: detail }];
        }
        this.denied.push(e.toolName);
        return [
          { kind: "tool_result", callId: e.toolCallId, tool: e.toolName, ok: false, output: detail },
          { kind: "permission_denied", tool: e.toolName, detail },
        ];
      }
      case "run_error":
        return [{ kind: "diagnostic", text: `run error: ${textOf(e.error) ?? "unknown"}` }];
      case "notice":
        return e.level === "info" ? [] : [{ kind: "diagnostic", text: String(e.message ?? "") }];
      default:
        // Deltas, turn and model request bookkeeping, hook progress.
        return [];
    }
  }

  finish(exitCode: number | null): AgentEvent[] {
    return this.terminated ? [] : [exitWithoutResult(exitCode, this.sessionId)];
  }

  private result(msg: Record<string, any>): AgentEvent[] {
    this.terminated = true;
    const sessionId: string = msg.sessionId ?? this.sessionId ?? "";
    if (msg.subtype === "error") {
      const reason = textOf(msg.error) ?? msg.finalText ?? "Command Code reported an error";
      return [{ kind: "failed", sessionId, reason: typeof reason === "string" ? reason : JSON.stringify(reason) }];
    }
    const text: string = typeof msg.finalText === "string" ? msg.finalText : "";
    const answer = parseJsonAnswer(text);
    const usage = toUsage(msg.usage);
    return [
      {
        kind: "completed",
        sessionId,
        result: answer && typeof answer === "object" ? answer : text,
        // max_turns: stopped before finishing.
        success: msg.subtype === "success" && this.denied.length === 0,
        deniedActions: [...this.denied],
        ...(typeof msg.durationMs === "number" && { durationMs: msg.durationMs }),
        ...(usage && { usage }),
      },
    ];
  }
}
