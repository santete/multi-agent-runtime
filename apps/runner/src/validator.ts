import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationReport, ValidationStep, ValidationStepResult } from "@mar/core";
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
function runStep(step: ValidationStep, cwd: string, signal?: AbortSignal): Promise<ValidationStepResult> {
  const started = Date.now();
  const timeoutMs = (step.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve) => {
    let output = "";
    let killedReason: string | undefined;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("MAR_")) delete env[key];

    const child = spawn(step.command, { cwd, shell: true, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (d: Buffer) => {
      output = (output + d.toString()).slice(-TAIL_CHARS * 4);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const kill = (reason: string) => {
      if (killedReason || child.exitCode !== null) return;
      killedReason = reason;
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
    const result = await runStep(step, worktree, signal);
    results.push(result);
    if (!result.passed) break;
  }
  const passed = !signal?.aborted && results.length === steps.length && results.every((r) => r.passed);
  return { passed, steps: results, changedFiles: await changedFiles(worktree) };
}
