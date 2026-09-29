/**
 * Agent adapter contract (product-spec §16/§58, revised in ADR-0003).
 *
 * Adapters translate the platform's run request into one CLI invocation and
 * normalize the CLI's output stream into AgentEvents. The runner owns process
 * lifecycle; an adapter only builds the command and parses output lines.
 */

export type PauseSupport = "native" | "checkpoint" | "none";

/** How the agent lets the platform gate tool calls. */
export type ApprovalSupport =
  /** A pre-tool hook can allow/deny each call (Claude Code, Antigravity). */
  | "pre-tool-hook"
  /** Only a static allow/deny list; denied calls are reported afterwards. */
  | "static-rules"
  | "none";

export interface AdapterCapabilities {
  pause: PauseSupport;
  resume: boolean;
  approval: ApprovalSupport;
  structuredOutput: boolean;
  streaming: boolean;
  costReporting: boolean;
}

export type PermissionProfile =
  /** Edits auto-applied; commands only via the policy hook. */
  | "edit"
  /** Read-only analysis (architecture, review). */
  | "read-only";

export interface AgentRunRequest {
  /** Absolute path of the task workspace (git worktree). */
  workspace: string;
  prompt: string;
  /** Resume an earlier agent session instead of starting a new one. */
  resumeSessionId?: string;
  model?: string;
  permissionProfile: PermissionProfile;
  /** JSON schema the final answer must follow (structured artifact). */
  outputSchema?: object;
  timeoutSeconds?: number;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Written to the process stdin, then stdin is closed (avoids argv length/quoting limits). */
  stdin?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
}

export type AgentEvent =
  | { kind: "session_started"; sessionId: string; model?: string }
  | { kind: "message"; text: string }
  | { kind: "tool_call"; callId: string; tool: string; input: unknown }
  | { kind: "tool_result"; callId: string; tool?: string; ok: boolean; output?: string }
  | { kind: "permission_denied"; tool: string; detail?: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "diagnostic"; text: string }
  | {
      kind: "completed";
      sessionId: string;
      /** Final text or structured object. */
      result: unknown;
      /**
       * True only if the agent ran to the end without errors or denied actions.
       * A CLI reporting "success" with denied actions is NOT a success (ADR-0003).
       */
      success: boolean;
      deniedActions: string[];
      costUsd?: number;
      durationMs?: number;
      usage?: TokenUsage;
    }
  | { kind: "failed"; sessionId?: string; reason: string };

export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  buildCommand(request: AgentRunRequest): CommandSpec;
  /** Stateful per-run parser: one instance per process. */
  createParser(): AgentOutputParser;
}

export interface AgentOutputParser {
  /** Parse one stdout line; returns zero or more normalized events. */
  push(line: string): AgentEvent[];
}
