import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentOutputParser,
  type AgentRunRequest,
  type CommandSpec,
} from "@mar/core";

export interface GenericCliAdapterOptions {
  command: string;
  /** Arguments; the literal `{prompt}` is replaced by the task prompt. */
  args?: string[];
  /** Deliver the prompt on stdin instead of (or in addition to) `{prompt}`. */
  promptViaStdin?: boolean;
  env?: Record<string, string>;
}

const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Wraps any command-line tool: every stdout line becomes a message and the
 * exit code decides success. The runner owner configures the command, so a
 * task can only choose which configured agent runs, never an arbitrary binary.
 */
export class GenericCliAdapter implements AgentAdapter {
  readonly id = "generic-cli";
  readonly capabilities: AdapterCapabilities = {
    pause: "none",
    resume: false,
    approval: "none",
    structuredOutput: false,
    streaming: true,
    costReporting: false,
  };

  constructor(private readonly options: GenericCliAdapterOptions) {}

  buildCommand(request: AgentRunRequest): CommandSpec {
    const args = (this.options.args ?? [PROMPT_PLACEHOLDER]).map((a) =>
      a.split(PROMPT_PLACEHOLDER).join(request.prompt),
    );
    return {
      command: this.options.command,
      args,
      cwd: request.workspace,
      ...(this.options.env && { env: this.options.env }),
      ...(this.options.promptViaStdin && { stdin: request.prompt }),
    };
  }

  createParser(): AgentOutputParser {
    return new GenericCliParser();
  }
}

/** Last lines kept as the run's result text. */
const RESULT_TAIL_LINES = 20;

export class GenericCliParser implements AgentOutputParser {
  private readonly tail: string[] = [];

  push(line: string): AgentEvent[] {
    const text = line.replace(/\r$/, "");
    if (!text.trim()) return [];
    this.tail.push(text);
    if (this.tail.length > RESULT_TAIL_LINES) this.tail.shift();
    return [{ kind: "message", text }];
  }

  finish(exitCode: number | null): AgentEvent[] {
    if (exitCode === null) return [{ kind: "failed", reason: "process was killed" }];
    return [
      {
        kind: "completed",
        sessionId: "",
        result: this.tail.join("\n"),
        success: exitCode === 0,
        deniedActions: [],
      },
    ];
  }
}
