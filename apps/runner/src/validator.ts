import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnvironmentFailure, type ValidationReport, type ValidationSandbox, type ValidationStep, type ValidationStepResult } from "@mar/core";
import { SpanStatusCode, withSpan } from "@mar/telemetry";
import { killTree } from "./process.js";
import { changedFiles, conflictedFiles } from "./worktree.js";

const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
const TAIL_LINES = 60;
const TAIL_CHARS = 8000;

function tail(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}

/**
 * Runs one project-defined validation command in the worktree. Commands come
 * from the project configuration (like CI jobs), never from the agent. The
 * agent's execution token is not passed on.
 */
export interface ValidationOptions {
  /** Run each step in a container from this image (ADR-0018). */
  sandbox?: ValidationSandbox | null | undefined;
  /** Container CLI (docker, or a compatible one such as podman). */
  containerRuntime?: string | undefined;
  /** Project secrets for the validation (spec §48), as environment variables. */
  env?: Record<string, string> | undefined;
}

/**
 * `<runtime> run` arguments for a step: no network unless asked, no
 * capabilities, no privilege escalation, the worktree mounted at /workspace.
 */
export function containerArgs(step: ValidationStep, worktree: string, sandbox: ValidationSandbox, name: string, envNames: string[] = []): string[] {
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid?.() ?? 0}`] : [];
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    sandbox.network ? "bridge" : "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(sandbox.memory ? ["--memory", sandbox.memory] : []),
    ...(sandbox.cpus ? ["--cpus", String(sandbox.cpus)] : []),
    ...user,
    "-v",
    `${worktree}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=true",
    // Secrets: `-e NAME` passes the value from the container CLI's environment, never on the command line.
    ...envNames.flatMap((n) => ["-e", n]),
    sandbox.image,
    "sh",
    "-c",
    step.command,
  ];
}

let containerSeq = 0;

export function runStep(step: ValidationStep, cwd: string, signal?: AbortSignal, options: ValidationOptions = {}): Promise<ValidationStepResult> {
  const started = Date.now();
  const timeoutMs = (step.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve) => {
    let output = "";
    let killedReason: string | undefined;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("MAR_")) delete env[key];
    Object.assign(env, options.env);

    const runtime = options.containerRuntime ?? "docker";
    const container = options.sandbox ? `mar-validate-${process.pid}-${++containerSeq}-${Date.now()}` : undefined;
    const child = options.sandbox
      ? spawn(runtime, containerArgs(step, cwd, options.sandbox, container!, Object.keys(options.env ?? {})), { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(step.command, { cwd, shell: true, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (d: Buffer) => {
      output = (output + d.toString()).slice(-TAIL_CHARS * 4);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const kill = (reason: string) => {
      if (killedReason || child.exitCode !== null) return;
      killedReason = reason;
      // Killing the CLI does not stop the container itself.
      if (container) spawn(runtime, ["kill", container], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
      killTree(child.pid, () => child.kill());
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const onAbort = () => kill("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const done = (exitCode: number | null, error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const note = error ? `\n[runner] failed to start: ${error.message}` : killedReason ? `\n[runner] ${killedReason}` : "";
      resolve({
        name: step.name,
        command: step.command,
        passed: !error && !killedReason && exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        outputTail: tail(output + note),
      });
    };
    child.on("error", (err) => done(null, err));
    child.on("close", (code) => done(code));
  });
}

const CONFLICT_MARKER = /^(<{7} |={7}$|>{7} )/m;

/** Files from an in-progress merge that still contain conflict markers. */
async function unresolvedConflicts(worktree: string): Promise<string[]> {
  const files = await conflictedFiles(worktree);
  const unresolved: string[] = [];
  for (const file of files) {
    const text = await readFile(join(worktree, file), "utf8").catch(() => "");
    if (CONFLICT_MARKER.test(text)) unresolved.push(file);
  }
  return unresolved;
}

/**
 * Runs all steps in order, stopping at the first failure. A merge with
 * unresolved conflict markers fails before any project step runs.
 */
export async function runValidation(
  worktree: string,
  steps: ValidationStep[],
  signal?: AbortSignal,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const unresolved = await unresolvedConflicts(worktree);
  if (unresolved.length) {
    return {
      passed: false,
      steps: [
        {
          name: "merge-conflicts",
          command: "(runner) check for conflict markers",
          passed: false,
          exitCode: null,
          durationMs: 0,
          outputTail: `Unresolved conflict markers in:\n${unresolved.join("\n")}`,
        },
      ],
      changedFiles: await changedFiles(worktree),
    };
  }

  const results: ValidationStepResult[] = [];
  for (const step of steps) {
    if (signal?.aborted) break;
    const result = await withSpan(
      `validation.step ${step.name}`,
      { "mar.validation.step": step.name, ...(options.sandbox && { "mar.validation.image": options.sandbox.image }) },
      async (span) => {
      const r = await runStep(step, worktree, signal, options);
      span.setAttributes({ "mar.validation.passed": r.passed, "process.exit.code": r.exitCode ?? -1 });
      if (!r.passed) span.setStatus({ code: SpanStatusCode.ERROR, message: `${step.name} failed` });
      return r;
      },
    );
    results.push(!result.passed && isEnvironmentFailure(result) ? { ...result, environment: true } : result);
    if (!result.passed) break;
  }
  const passed = !signal?.aborted && results.length === steps.length && results.every((r) => r.passed);
  return { passed, steps: results, changedFiles: await changedFiles(worktree) };
}
