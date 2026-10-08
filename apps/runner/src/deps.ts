import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationSandbox, ValidationStepResult } from "@mar/core";
import { runStep } from "./validator.js";

/**
 * Dependencies are the runner's job, not the agent's: a fresh worktree has no
 * `node_modules`, and agents in a sandbox (Codex: no network, no pnpm) cannot
 * install them, so their validation failed eight times in a row on "jest is
 * not recognized". The runner has the network and the tools; it installs once
 * per lockfile into a shared package store.
 */

export interface InstallPlan {
  command: string;
  /** Tried when the command itself is missing (pnpm not on PATH). */
  fallback?: string;
  lockfile: string;
}

const PLANS: Array<{ lockfile: string; command: string; fallback?: string }> = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile", fallback: "corepack pnpm install --frozen-lockfile" },
  { lockfile: "package-lock.json", command: "npm ci" },
  { lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
];

/** What installs the worktree's dependencies; `override` is the runner config's own command. */
export function installPlan(worktree: string, override?: string): InstallPlan | null {
  if (!existsSync(join(worktree, "package.json"))) return null;
  const found = PLANS.find((p) => existsSync(join(worktree, p.lockfile)));
  if (override) return { command: override, lockfile: found?.lockfile ?? "package.json" };
  return found ? { command: found.command, ...(found.fallback && { fallback: found.fallback }), lockfile: found.lockfile } : null;
}

const MARKER = join("node_modules", ".mar-install");

/** `flavor`: node_modules installed on the host and in a container are not interchangeable (other OS, other binaries). */
async function stamp(worktree: string, plan: InstallPlan, flavor: string): Promise<string> {
  const lock = await readFile(join(worktree, plan.lockfile)).catch(() => Buffer.alloc(0));
  return createHash("sha256").update(flavor).update(plan.command).update(lock).digest("hex");
}

export interface InstallOptions {
  /** The runner's home: the package store and the corepack cache live under it. */
  home: string;
  /** From the runner config; a command, or nothing for the lockfile's default. */
  command?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * The project validates in a container: install there too (with network access, unlike its validation
   * steps), so that node_modules match the image and not the host.
   */
  sandbox?: ValidationSandbox | null | undefined;
  containerRuntime?: string | undefined;
}

export interface InstallResult {
  /** True when `node_modules` already matched the lockfile. */
  skipped: boolean;
  step: ValidationStepResult;
}

/**
 * Installs when `node_modules` is missing or the lockfile changed since the last
 * install. Null when the project has nothing to install.
 */
export async function ensureDependencies(worktree: string, options: InstallOptions): Promise<InstallResult | null> {
  const plan = installPlan(worktree, options.command);
  if (!plan) return null;
  const flavor = options.sandbox ? `container:${options.sandbox.image}` : "host";
  const want = await stamp(worktree, plan, flavor);
  const have = await readFile(join(worktree, MARKER), "utf8").catch(() => "");
  if (existsSync(join(worktree, "node_modules")) && have.trim() === want) {
    return { skipped: true, step: { name: "install", command: plan.command, passed: true, exitCode: 0, durationMs: 0, outputTail: "node_modules up to date" } };
  }
  const env = {
    // pnpm reads npm_config_*: one content-addressed store for every worktree, so installs are links, not downloads.
    npm_config_store_dir: join(options.home, "pnpm-store"),
    COREPACK_HOME: join(options.home, "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    CI: "true",
  };
  await mkdir(env.COREPACK_HOME, { recursive: true });
  const run = (command: string) => runStep({ name: "install", command, timeoutSeconds: 900 }, worktree, options.signal, { env });
  if (options.sandbox) {
    // corepack ships with Node images; the validation steps themselves still run without network.
    const command = options.command ? plan.command : `corepack enable >/dev/null 2>&1; ${plan.command}`;
    const step = await runStep({ name: "install", command, timeoutSeconds: 900 }, worktree, options.signal, {
      sandbox: { ...options.sandbox, network: true },
      containerRuntime: options.containerRuntime,
    });
    if (step.passed) {
      await mkdir(join(worktree, "node_modules"), { recursive: true });
      await writeFile(join(worktree, MARKER), want);
    }
    return { skipped: false, step };
  }
  let step = await run(plan.command);
  if (!step.passed && plan.fallback && /not recognized|not found|ENOENT/i.test(step.outputTail)) step = await run(plan.fallback);
  if (step.passed) {
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, MARKER), want);
  }
  return { skipped: false, step };
}
