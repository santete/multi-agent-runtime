import { ClaudeStreamParser } from "@mar/adapter-claude-code";
import {
  hookCommandLine,
  parseJsonAnswer,
  POLICY_HOOK_TIMEOUT_SECONDS,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentOutputParser,
  type AgentRunRequest,
  type CommandSpec,
  type WorkspaceFile,
} from "@mar/core";

export const QODER_SETTINGS_FILE = ".qoder/settings.local.json";

/** Built-in tools of an orchestrated run: no scheduling, background work, worktrees or media generation. */
export const QODER_EDIT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
];
/** qodercli has no plan mode: read-only runs get no tool that writes or runs commands. */
export const QODER_READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

/** A call the hook denied: `Error: <hook command> hook blocking error from command: "<command>": <reason>`. */
const HOOK_BLOCKED = /hook blocking error/i;
/** A call that needed a permission prompt, which headless runs answer with no: `Error: Allow Bash to run: <command>?`. */
const PROMPT_DENIED = /^Error: Allow \w+ to /;
/** The policy hook's reason starts with the risk level. */
const HOOK_REASON = /\[(?:LOW|MEDIUM|HIGH|CRITICAL)\][\s\S]*$/;

export interface QoderAdapterOptions {
  /** Executable name or absolute path (default install: ~/.qoder/bin/qodercli/qodercli.exe). */
  executable?: string;
  /** Built-in tools of edit runs (default QODER_EDIT_TOOLS). */
  tools?: string[];
}

/**
 * Qoder CLI (`qodercli -p --output-format stream-json`), whose stream and
 * hooks follow Claude Code's. Verified against qodercli 1.1.65, see
 * docs/spikes/adapter-capability-matrix.md and ADR-0035.
 *
 * Differences handled here:
 * - Hooks passed with --settings only load when every setting source does,
 *   personal ones included; the policy hook goes into the workspace's
 *   `.qoder/settings.local.json` instead, so runs keep `project,local`.
 * - No --json-schema: the schema goes into the system prompt and the final
 *   answer is parsed as JSON.
 * - Denied calls (by the hook or a headless permission prompt) are not listed
 *   in `permission_denials`; they are read from the tool results.
 * - Usage is reported as Qoder credits, not tokens or USD.
 */
export class QoderAdapter implements AgentAdapter {
  readonly id = "qoder";
  readonly capabilities: AdapterCapabilities = {
    pause: "checkpoint",
    resume: true,
    approval: "pre-tool-hook",
    structuredOutput: true,
    promptedSchema: true,
    streaming: true,
    costReporting: false,
  };

  constructor(private readonly options: QoderAdapterOptions = {}) {}

  buildCommand(request: AgentRunRequest): CommandSpec {
    const readOnly = request.permissionProfile === "read-only";
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      // Only project/local settings: the user's personal hooks must not leak into orchestrated runs.
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--permission-mode",
      readOnly ? "default" : "accept_edits",
      "--tools",
      (readOnly ? QODER_READ_ONLY_TOOLS : (this.options.tools ?? QODER_EDIT_TOOLS)).join(","),
    ];
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    if (request.model) args.push("--model", request.model);
    if (request.outputSchema) {
      args.push(
        "--append-system-prompt",
        "Your final message must be only a JSON object that validates against this JSON schema (your answer, not the schema itself), " +
          `with no other text and no code fence:\n${JSON.stringify(request.outputSchema)}`,
      );
    }
    return {
      command: this.options.executable ?? "qodercli",
      args,
      cwd: request.workspace,
      stdin: request.prompt,
      ...(request.env && { env: request.env }),
    };
  }

  workspaceFiles(request: AgentRunRequest): WorkspaceFile[] {
    if (!request.policyHook) return [];
    const hook = { type: "command", command: hookCommandLine(request.policyHook, "claude"), timeout: POLICY_HOOK_TIMEOUT_SECONDS };
    return [{ path: QODER_SETTINGS_FILE, mergeJson: true, content: { hooks: { PreToolUse: [{ matcher: "*", hooks: [hook] }] } } }];
  }

  createParser(): AgentOutputParser {
    return new QoderStreamParser();
  }
}

export class QoderStreamParser implements AgentOutputParser {
  private readonly inner = new ClaudeStreamParser();
  private readonly denied: string[] = [];

  push(line: string): AgentEvent[] {
    return this.inner.push(line).flatMap((e) => this.adjust(e));
  }

  finish(exitCode: number | null): AgentEvent[] {
    return this.inner.finish(exitCode);
  }

  private adjust(e: AgentEvent): AgentEvent[] {
    if (e.kind === "tool_result" && !e.ok && e.output && (HOOK_BLOCKED.test(e.output) || PROMPT_DENIED.test(e.output))) {
      const tool = e.tool ?? "unknown";
      this.denied.push(tool);
      const detail = HOOK_BLOCKED.test(e.output) ? (HOOK_REASON.exec(e.output)?.[0] ?? e.output) : e.output.replace(/^Error: /, "");
      return [e, { kind: "permission_denied", tool, detail }];
    }
    if (e.kind !== "completed") return [e];

    const { costUsd, usage, ...rest } = e;
    const deniedActions = [...e.deniedActions, ...this.denied];
    const answer = typeof e.result === "string" ? parseJsonAnswer(e.result) : undefined;
    return [
      {
        ...rest,
        result: answer && typeof answer === "object" ? answer : e.result,
        success: e.success && deniedActions.length === 0,
        deniedActions,
        // Qoder bills credits: its USD cost and token counts are always zero.
        ...(costUsd && { costUsd }),
        ...(usage && (usage.inputTokens || usage.outputTokens) && { usage }),
      },
    ];
  }
}
