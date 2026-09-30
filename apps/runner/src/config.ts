import { readFile } from "node:fs/promises";
import { AntigravityAdapter } from "@mar/adapter-antigravity";
import { ClaudeCodeAdapter } from "@mar/adapter-claude-code";
import { GenericCliAdapter } from "@mar/adapter-generic-cli";
import type { AgentAdapter } from "@mar/core";
import { z } from "zod";

const agentConfig = z.discriminatedUnion("adapter", [
  z.object({ adapter: z.literal("claude-code"), executable: z.string().optional() }),
  z.object({
    adapter: z.literal("antigravity"),
    executable: z.string().optional(),
    defaultTimeoutSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    adapter: z.literal("generic-cli"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    promptViaStdin: z.boolean().optional(),
  }),
]);

export const runnerConfig = z.object({
  controlPlaneUrl: z.url(),
  name: z.string().min(1),
  /** Where repos and worktrees live. */
  home: z.string().min(1),
  /** Bearer token for the control plane API (or env MAR_API_TOKEN). */
  apiToken: z.string().min(1).optional(),
  pollIntervalMs: z.number().int().positive().default(2000),
  heartbeatIntervalMs: z.number().int().positive().default(10_000),
  /** How often worktrees of finished (merged or cancelled) tasks are removed. */
  gcIntervalMs: z.number().int().positive().default(300_000),
  maxConcurrent: z.number().int().positive().default(2),
  timeoutSeconds: z.number().int().positive().default(1800),
  /** Install the platform PreToolUse policy hook into agents that support it. */
  policyHook: z.boolean().default(true),
  /** Author of the commits the runner makes for delivered tasks. */
  gitAuthor: z
    .object({ name: z.string().min(1), email: z.string().min(3) })
    .default({ name: "multi-agent-runtime", email: "mar-bot@users.noreply.github.com" }),
  /** Logical agent id (what tasks ask for) -> how this machine runs it. */
  agents: z.record(z.string(), agentConfig),
});

export type RunnerConfig = z.infer<typeof runnerConfig>;
export type RunnerConfigInput = z.input<typeof runnerConfig>;
export type AgentConfig = z.infer<typeof agentConfig>;

export async function loadConfig(path: string): Promise<RunnerConfigInput> {
  return JSON.parse(await readFile(path, "utf8")) as RunnerConfigInput;
}

export function createAdapter(config: AgentConfig): AgentAdapter {
  switch (config.adapter) {
    case "claude-code":
      return new ClaudeCodeAdapter({ ...(config.executable && { executable: config.executable }) });
    case "antigravity":
      return new AntigravityAdapter({
        ...(config.executable && { executable: config.executable }),
        ...(config.defaultTimeoutSeconds && { defaultTimeoutSeconds: config.defaultTimeoutSeconds }),
      });
    case "generic-cli":
      return new GenericCliAdapter({
        command: config.command,
        ...(config.args && { args: config.args }),
        ...(config.promptViaStdin !== undefined && { promptViaStdin: config.promptViaStdin }),
      });
  }
}
