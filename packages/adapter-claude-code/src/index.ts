import {
  exitWithoutResult,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentOutputParser,
  type AgentRunRequest,
  type CommandSpec,
  type TokenUsage,
} from "@mar/core";

export interface ClaudeCodeAdapterOptions {
  /** Executable name or absolute path. */
  executable?: string;
  /**
   * Settings JSON injected with --settings, e.g. the orchestrator's PreToolUse
   * policy hook. Keeps per-run policy out of the user's own settings.
   */
  settings?: object;
}

/**
 * Claude Code CLI in headless mode (`claude -p --output-format stream-json`).
 * Verified against Claude Code 2.1.284, see docs/spikes/adapter-capability-matrix.md.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly capabilities: AdapterCapabilities = {
    pause: "checkpoint",
    resume: true,
    approval: "pre-tool-hook",
    structuredOutput: true,
    streaming: true,
    costReporting: true,
  };

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  buildCommand(request: AgentRunRequest): CommandSpec {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Only project/local settings: the user's personal hooks and plugins must
      // not leak into orchestrated runs.
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--permission-mode",
      request.permissionProfile === "read-only" ? "plan" : "acceptEdits",
    ];
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    if (request.model) args.push("--model", request.model);
    if (request.outputSchema) args.push("--json-schema", JSON.stringify(request.outputSchema));
    if (this.options.settings) args.push("--settings", JSON.stringify(this.options.settings));

    return {
      command: this.options.executable ?? "claude",
      args,
      cwd: request.workspace,
      stdin: request.prompt,
    };
  }

  createParser(): AgentOutputParser {
    return new ClaudeStreamParser();
  }
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

function toUsage(u: ClaudeUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.cache_read_input_tokens !== undefined && { cacheReadTokens: u.cache_read_input_tokens }),
  };
}

function stringifyToolOutput(content: unknown): string | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { text?: string }) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content);
}

export class ClaudeStreamParser implements AgentOutputParser {
  private sessionId: string | undefined;
  private terminated = false;
  private readonly toolNames = new Map<string, string>();

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
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
          return [{ kind: "session_started", sessionId: msg.session_id, ...(msg.model && { model: msg.model }) }];
        }
        return [];

      case "assistant":
        return this.blocks(msg).flatMap((b): AgentEvent[] => {
          if (b.type === "text" && b.text) return [{ kind: "message", text: b.text }];
          if (b.type === "tool_use" && b.id && b.name) {
            this.toolNames.set(b.id, b.name);
            return [{ kind: "tool_call", callId: b.id, tool: b.name, input: b.input }];
          }
          return [];
        });

      case "user":
        return this.blocks(msg).flatMap((b): AgentEvent[] => {
          if (b.type !== "tool_result" || !b.tool_use_id) return [];
          const tool = this.toolNames.get(b.tool_use_id);
          const output = stringifyToolOutput(b.content);
          return [
            {
              kind: "tool_result",
              callId: b.tool_use_id,
              ...(tool && { tool }),
              ok: !b.is_error,
              ...(output !== undefined && { output }),
            },
          ];
        });

      case "result":
        return this.result(msg);

      default:
        // rate_limit_event, hook lifecycle events, etc.
        return [];
    }
  }

  private blocks(msg: Record<string, any>): ContentBlock[] {
    const content = msg.message?.content;
    return Array.isArray(content) ? content : [];
  }

  finish(exitCode: number | null): AgentEvent[] {
    return this.terminated ? [] : [exitWithoutResult(exitCode, this.sessionId)];
  }

  private result(msg: Record<string, any>): AgentEvent[] {
    this.terminated = true;
    const denials: Array<{ tool_name?: string }> = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
    const deniedActions = denials.map((d) => d.tool_name ?? "unknown");
    const sessionId = msg.session_id ?? this.sessionId ?? "";
    const usage = toUsage(msg.usage);
    const events: AgentEvent[] = deniedActions.map((tool) => ({ kind: "permission_denied", tool }));
    events.push({
      kind: "completed",
      sessionId,
      result: msg.structured_output ?? msg.result,
      success: msg.subtype === "success" && !msg.is_error && deniedActions.length === 0,
      deniedActions,
      ...(typeof msg.total_cost_usd === "number" && { costUsd: msg.total_cost_usd }),
      ...(typeof msg.duration_ms === "number" && { durationMs: msg.duration_ms }),
      ...(usage && { usage }),
    });
    return events;
  }
}
