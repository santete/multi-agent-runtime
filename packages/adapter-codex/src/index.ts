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

export interface CodexAdapterOptions {
  /** Executable name or absolute path (npm installs `codex.cmd` on Windows; the runner unwraps it). */
  executable?: string;
  /** Target platform of the runner (for tests); defaults to the current one. */
  platform?: NodeJS.Platform;
}

/** Written into the workspace because Codex takes the output schema as a file. */
export const CODEX_SCHEMA_FILE = ".orchestrator/handoff.schema.json";
const CODEX_HOOKS_FILE = ".codex/hooks.json";

/**
 * OpenAI Codex CLI (`codex exec --json`). Verified against codex-cli 0.159.2,
 * see docs/spikes/adapter-capability-matrix.md and ADR-0010.
 *
 * - Runs hermetically (`--ignore-user-config`) in Codex's own sandbox
 *   (`workspace-write`: writes only inside the workspace, no network). On
 *   Windows the elevated sandbox must be named explicitly, otherwise every
 *   command is rejected (openai/codex#42172).
 * - The platform PreToolUse hook is installed as `.codex/hooks.json` in the
 *   trusted workspace, but Codex on Windows does not fire PreToolUse for
 *   shell commands (openai/codex#24453). Hence `approval: "sandbox"`: the
 *   sandbox confines the agent and the control plane audits every tool call.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly capabilities: AdapterCapabilities = {
    pause: "checkpoint",
    resume: true,
    approval: "sandbox",
    structuredOutput: true,
    streaming: true,
    costReporting: false,
  };

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  private get windows(): boolean {
    return (this.options.platform ?? process.platform) === "win32";
  }

  buildCommand(request: AgentRunRequest): CommandSpec {
    // On Windows the read-only sandbox rejects every command, reads included, so
    // read-only runs (reviews) use workspace-write there; the runner never
    // delivers anything from a read-only run's worktree.
    const sandbox = request.permissionProfile === "read-only" && !this.windows ? "read-only" : "workspace-write";
    const config = [
      `sandbox_mode="${sandbox}"`,
      'approval_policy="never"',
      ...(this.windows ? ['windows.sandbox="elevated"'] : []),
      ...(request.model ? [`model=${JSON.stringify(request.model)}`] : []),
      ...(request.policyHook ? [`projects.${JSON.stringify(request.workspace)}.trust_level="trusted"`] : []),
    ];
    const args = [
      "exec",
      ...(request.resumeSessionId ? ["resume", request.resumeSessionId] : []),
      "--json",
      "--ignore-user-config",
      ...config.flatMap((c) => ["-c", c]),
      ...(request.outputSchema ? ["--output-schema", CODEX_SCHEMA_FILE] : []),
      // Our own hook, installed by the runner; nothing else is trusted this way.
      ...(request.policyHook ? ["--dangerously-bypass-hook-trust"] : []),
      "-",
    ];
    return {
      command: this.options.executable ?? "codex",
      args,
      cwd: request.workspace,
      stdin: request.prompt,
      ...(request.env && { env: request.env }),
    };
  }

  workspaceFiles(request: AgentRunRequest): WorkspaceFile[] {
    const files: WorkspaceFile[] = [];
    if (request.outputSchema) files.push({ path: CODEX_SCHEMA_FILE, content: request.outputSchema, mergeJson: false });
    if (request.policyHook) {
      // Codex hook payloads and responses follow Claude Code's format; matchers are regexes.
      const hook = { type: "command", command: hookCommandLine(request.policyHook, "claude"), timeout: POLICY_HOOK_TIMEOUT_SECONDS };
      files.push({
        path: CODEX_HOOKS_FILE,
        mergeJson: true,
        content: { hooks: { PreToolUse: [{ matcher: ".*", hooks: [hook] }] } },
      });
    }
    return files;
  }

  createParser(): AgentOutputParser {
    return new CodexStreamParser();
  }
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function toUsage(u: CodexUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.cached_input_tokens !== undefined && { cacheReadTokens: u.cached_input_tokens }),
    ...(u.reasoning_output_tokens !== undefined && { thinkingTokens: u.reasoning_output_tokens }),
  };
}

const OUTPUT_TAIL = 4000;

/** Parses `codex exec --json` (JSONL of thread / turn / item events). */
export class CodexStreamParser implements AgentOutputParser {
  private sessionId: string | undefined;
  private lastMessage: string | undefined;
  private terminated = false;
  private readonly started = new Set<string>();

  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [{ kind: "diagnostic", text: trimmed }];
    }

    switch (msg.type) {
      case "thread.started":
        this.sessionId = msg.thread_id;
        return [{ kind: "session_started", sessionId: msg.thread_id }];
      case "item.started":
        return this.itemStarted(msg.item ?? {});
      case "item.completed":
        return this.itemCompleted(msg.item ?? {});
      case "turn.completed":
        return this.completed(msg.usage);
      case "turn.failed":
        this.terminated = true;
        return [{ kind: "failed", ...(this.sessionId && { sessionId: this.sessionId }), reason: msg.error?.message ?? "turn failed" }];
      case "error":
        return [{ kind: "diagnostic", text: msg.message ?? JSON.stringify(msg) }];
      default:
        return [];
    }
  }

  finish(exitCode: number | null): AgentEvent[] {
    return this.terminated ? [] : [exitWithoutResult(exitCode, this.sessionId)];
  }

  private toolCall(item: Record<string, any>): AgentEvent | undefined {
    if (item.type === "command_execution") {
      return { kind: "tool_call", callId: item.id, tool: "shell", input: { command: item.command } };
    }
    if (item.type === "file_change") {
      const changes: Array<{ path: string; kind: string }> = item.changes ?? [];
      return { kind: "tool_call", callId: item.id, tool: "apply_patch", input: { paths: changes.map((c) => c.path), changes } };
    }
    if (item.type === "mcp_tool_call") {
      return { kind: "tool_call", callId: item.id, tool: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    }
    return undefined;
  }

  private itemStarted(item: Record<string, any>): AgentEvent[] {
    const call = this.toolCall(item);
    if (!call) return [];
    this.started.add(item.id);
    return [call];
  }

  private itemCompleted(item: Record<string, any>): AgentEvent[] {
    switch (item.type) {
      case "agent_message":
        this.lastMessage = item.text;
        return [{ kind: "message", text: item.text }];
      case "error":
        return [{ kind: "diagnostic", text: item.message }];
      case "command_execution":
      case "file_change":
      case "mcp_tool_call": {
        // File changes can complete without a separate "started" event.
        const events: AgentEvent[] = this.started.has(item.id) ? [] : [this.toolCall(item)!];
        const ok = item.type === "command_execution" ? item.exit_code === 0 && item.status === "completed" : item.status !== "failed";
        const output = typeof item.aggregated_output === "string" ? item.aggregated_output.slice(-OUTPUT_TAIL) : undefined;
        events.push({
          kind: "tool_result",
          callId: item.id,
          tool: item.type === "command_execution" ? "shell" : item.type === "file_change" ? "apply_patch" : "mcp",
          ok,
          ...(output !== undefined && { output }),
        });
        return events;
      }
      default:
        return [];
    }
  }

  private completed(usage: CodexUsage | undefined): AgentEvent[] {
    this.terminated = true;
    const u = toUsage(usage);
    let result: unknown = this.lastMessage ?? "";
    // With --output-schema the final message is the JSON document.
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        // plain text answer
      }
    }
    return [
      {
        kind: "completed",
        sessionId: this.sessionId ?? "",
        result,
        success: true,
        deniedActions: [],
        ...(u && { usage: u }),
      },
    ];
  }
}
