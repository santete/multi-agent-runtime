import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveLaunchPath, stripBom } from "@mar/core/launch-path";
import { AntigravityAdapter } from "@mar/adapter-antigravity";
import { ClaudeCodeAdapter } from "@mar/adapter-claude-code";
import { CodexAdapter } from "@mar/adapter-codex";
import { GenericCliAdapter } from "@mar/adapter-generic-cli";
import { QoderAdapter } from "@mar/adapter-qoder";
import type { AgentAdapter } from "@mar/core";
import { z } from "zod";

/** Routing metadata common to every agent (spec §14-15). */
const routing = {
  skills: z.array(z.string().min(1)).default([]),
  cost: z.enum(["low", "medium", "high"]).default("medium"),
  /** USD per million tokens, to estimate cost when the CLI does not report it (spec §39). */
  pricing: z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }).optional(),
  /** At most this many executions of this agent at once (subscription concurrency). */
  maxConcurrent: z.number().int().min(1).optional(),
  /** Marketplace profile ("name" or "name@version"): skills, cost, pricing and instructions come from it. */
  profile: z.string().min(1).optional(),
};

const agentConfig = z.discriminatedUnion("adapter", [
  z.object({ adapter: z.literal("claude-code"), executable: z.string().optional(), ...routing }),
  z.object({ adapter: z.literal("codex"), executable: z.string().optional(), ...routing }),
  z.object({
    adapter: z.literal("antigravity"),
    executable: z.string().optional(),
    defaultTimeoutSeconds: z.number().int().positive().optional(),
    /** agy --sandbox without permission prompts, policed by the hook (ADR-0018). */
    unattended: z.boolean().default(false),
    /** Run agy with a profile of its own under the runner home, without the machine user's settings (default). */
    isolateConfig: z.boolean().default(true),
    ...routing,
  }),
  z.object({
    adapter: z.literal("qoder"),
    executable: z.string().optional(),
    /** Built-in tools of edit runs; read-only runs always get only the reading ones. */
    tools: z.array(z.string().min(1)).min(1).optional(),
    ...routing,
  }),
  z.object({
    adapter: z.literal("generic-cli"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    promptViaStdin: z.boolean().optional(),
    ...routing,
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
  /** Container CLI for projects that validate in a container (docker, podman). */
  containerRuntime: z.string().min(1).default("docker"),
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

/**
 * Reads the runner config from where the command was run (falling back to
 * apps/runner, where older instructions put it). A relative `home` is relative
 * to the config file. Problems are reported in one line.
 */
export async function loadConfig(path: string): Promise<RunnerConfigInput> {
  const file = resolveLaunchPath(path, { fallbackToCwd: true });
  if (!existsSync(file)) {
    throw new Error(`Runner config ${file} does not exist. Copy apps/runner/runner.config.example.json and list the agents installed on this machine.`);
  }
  let config: RunnerConfigInput;
  try {
    config = JSON.parse(stripBom(await readFile(file, "utf8"))) as RunnerConfigInput;
  } catch (err) {
    throw new Error(`Runner config ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  const checked = runnerConfig.safeParse(config);
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    throw new Error(`Runner config ${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}.`);
  }
  return typeof config.home === "string" ? { ...config, home: resolve(dirname(file), config.home) } : config;
}

/** The isolated profile directory of an agent. */
export const profileDirOf = (profilesDir: string, agentId: string) => join(profilesDir, agentId.replace(/[^\w.-]/g, "_"));

/** `profilesDir`: where agents with an isolated configuration keep their profiles (one per agent id). */
export function createAdapter(config: AgentConfig, profilesDir?: string, agentId = "agent"): AgentAdapter {
  switch (config.adapter) {
    case "codex":
      return new CodexAdapter({ ...(config.executable && { executable: config.executable }) });
    case "claude-code":
      return new ClaudeCodeAdapter({ ...(config.executable && { executable: config.executable }) });
    case "antigravity":
      return new AntigravityAdapter({
        ...(config.executable && { executable: config.executable }),
        ...(config.defaultTimeoutSeconds && { defaultTimeoutSeconds: config.defaultTimeoutSeconds }),
        unattended: config.unattended,
        ...(config.isolateConfig && profilesDir && { profileDir: profileDirOf(profilesDir, agentId) }),
      });
    case "qoder":
      return new QoderAdapter({
        ...(config.executable && { executable: config.executable }),
        ...(config.tools && { tools: config.tools }),
      });
    case "generic-cli":
      return new GenericCliAdapter({
        command: config.command,
        ...(config.args && { args: config.args }),
        ...(config.promptViaStdin !== undefined && { promptViaStdin: config.promptViaStdin }),
      });
  }
}
