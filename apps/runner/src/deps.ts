import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".orchestrator", ".runner"]);

/**
 * Directories (relative to the worktree, "" for the root) that hold a Prisma schema: the root and its direct
 * subdirectories. An installed `@prisma/client` without a generated client fails the TypeScript build on every
 * import of it ("Prisma has no exported member ...", seen live on the Ticket Booking project), which is the
 * machine's setup to finish, not the agent's code to fix.
 */
export function prismaDirs(worktree: string): string[] {
  const dirs = [""];
  try {
    for (const entry of readdirSync(worktree, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) dirs.push(entry.name);
    }
  } catch {
    // unreadable: no schema found
  }
  return dirs.filter((d) => existsSync(join(worktree, d, "prisma", "schema.prisma")));
}

/** `prisma generate` for a schema directory, run with the package manager the lockfile says. */
export function generateCommand(dir: string, lockfile: string): string {
  const exec = lockfile === "pnpm-lock.yaml" ? "pnpm exec prisma" : lockfile === "yarn.lock" ? "yarn prisma" : "npx prisma";
  return dir ? `cd ${dir} && ${exec} generate` : `${exec} generate`;
}

const MARKER = join("node_modules", ".mar-install");

/** `flavor`: node_modules installed on the host and in a container are not interchangeable (other OS, other binaries). */
async function stamp(worktree: string, plan: InstallPlan, flavor: string, schemas: string[]): Promise<string> {
  const lock = await readFile(join(worktree, plan.lockfile)).catch(() => Buffer.alloc(0));
  const hash = createHash("sha256").update(flavor).update(plan.command).update(lock);
  // A changed schema needs a new client.
  for (const dir of schemas) hash.update(await readFile(join(worktree, dir, "prisma", "schema.prisma")).catch(() => Buffer.alloc(0)));
  return hash.digest("hex");
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
  const schemas = prismaDirs(worktree);
  const want = await stamp(worktree, plan, flavor, schemas);
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
  // Generating the Prisma client needs no database, only a URL that parses (and the engines, from the network).
  const generateEnv = { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://mar:mar@localhost:5432/mar", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
  const finish = async (install: ValidationStepResult, generate: (command: string) => Promise<ValidationStepResult>): Promise<InstallResult> => {
    if (!install.passed) return { skipped: false, step: install };
    let last = install;
    for (const dir of schemas) {
      last = await generate(generateCommand(dir, plan.lockfile));
      if (!last.passed) return { skipped: false, step: { ...last, name: "prisma generate" } };
    }
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, MARKER), want);
    return { skipped: false, step: schemas.length ? { ...install, outputTail: `${install.outputTail}\n[runner] prisma client generated for ${schemas.map((d) => d || ".").join(", ")}`.slice(-8000) } : install };
  };

  if (options.sandbox) {
    // corepack ships with Node images; the validation steps themselves still run without network.
    const sandbox = { ...options.sandbox, network: true };
    const container = (command: string, extra: Record<string, string> = {}) =>
      runStep({ name: "install", command, timeoutSeconds: 900 }, worktree, options.signal, { sandbox, containerRuntime: options.containerRuntime, env: extra });
    const command = options.command ? plan.command : `corepack enable >/dev/null 2>&1; ${plan.command}`;
    const install = await container(command);
    return finish(install, (c) => container(`corepack enable >/dev/null 2>&1; ${c}`, generateEnv));
  }

  const host = (command: string, extra: Record<string, string> = {}) =>
    runStep({ name: "install", command, timeoutSeconds: 900 }, worktree, options.signal, { env: { ...env, ...extra } });
  let step = await host(plan.command);
  if (!step.passed && plan.fallback && /not recognized|not found|ENOENT/i.test(step.outputTail)) step = await host(plan.fallback);
  return finish(step, (c) => host(c, generateEnv));
}