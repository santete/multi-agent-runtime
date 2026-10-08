import type { ValidationStepResult } from "./api.js";

/**
 * Output that says the machine could not run the check, not that the code is
 * wrong: a missing tool or `node_modules`, a blocked file or network, a
 * service that is not there. Sending this back to the agent as "rework" only
 * burns attempts (seen live: eight reworks for "jest is not recognized").
 */
const ENVIRONMENT_OUTPUT: RegExp[] = [
  /is not recognized as (?:the name of )?(?:an? )?(?:internal|cmdlet|operable)/i,
  /command not found|^\s*(?:sh|bash|zsh): .*: not found\s*$/im,
  /node_modules (?:is )?missing|node_modules.{0,20}not (?:found|installed)|Local package\.json exists, but node_modules missing/i,
  /\b(?:EACCES|EPERM|ENOTFOUND|ECONNREFUSED|EAI_AGAIN)\b/,
  /Cannot connect to the Docker daemon|error during connect/i,
  /\[runner\] failed to start/,
  /ERR_PNPM_(?:NO_PKG_MANIFEST|OUTDATED_LOCKFILE|FETCH_|NO_MATCHING_VERSION)/,
];

/** The exit codes shells use for "no such command". */
const NOT_FOUND_EXIT_CODES = new Set([127, 9009]);

export function isEnvironmentFailure(step: Pick<ValidationStepResult, "passed" | "exitCode" | "outputTail">): boolean {
  if (step.passed) return false;
  if (step.exitCode !== null && NOT_FOUND_EXIT_CODES.has(step.exitCode)) return true;
  return ENVIRONMENT_OUTPUT.some((re) => re.test(step.outputTail));
}

/**
 * A stable summary of why validation failed: the failing step and its first
 * error line, with numbers and paths removed. The same fingerprint twice in a
 * row means another rework of the same agent will not help.
 */
export function failureFingerprint(steps: Array<Pick<ValidationStepResult, "name" | "passed" | "outputTail">>): string | null {
  const failed = steps.find((s) => !s.passed);
  if (!failed) return null;
  const lines = failed.outputTail
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|fail|not recognized|cannot|not found|✕|●/i.test(l)) ?? lines[lines.length - 1] ?? "";
  const normalized = line
    .toLowerCase()
    .replace(/\S*[\\/]\S*/g, "<path>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `${failed.name}: ${normalized}`;
}

const STOP_WORDS = new Set(["the", "and", "you", "can", "for", "that", "this", "with", "bạn", "có", "thể", "hoặc", "cho", "các", "một"]);

const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );

/**
 * Whether two questions ask the same thing in different words (agents re-ask
 * after every rework: "cung cấp worktree có node_modules?" vs "môi trường đã
 * cài dependencies?"). Word overlap, not exact text.
 */
export function similarQuestion(a: string, b: string): boolean {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
