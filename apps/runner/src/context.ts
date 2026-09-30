import type { ClaimResponse, WorkspaceFile } from "@mar/core";

/** Where the runner puts task context for the agent (git-excluded). */
export const CONTEXT_DIR = ".orchestrator/context";

function taskBrief({ task, project }: ClaimResponse): string {
  const validation = project.validation.length
    ? project.validation.map((s) => `- **${s.name}**: \`${s.command}\``).join("\n")
    : "- _None configured._";
  return [
    `# ${task.key}: ${task.title}`,
    "",
    "## Objective",
    "",
    task.objective,
    "",
    "## Rules",
    "",
    "- Work only inside this repository checkout (it is a dedicated git worktree for this task).",
    "- Do **not** commit, push, open pull requests or change git remotes. The platform commits, pushes and opens the pull request after validation.",
    "- Do not read or print secrets (.env files, keys, credentials).",
    "- Every tool call is checked by the platform policy; denied actions stop the task for human review.",
    "",
    "## Validation",
    "",
    "After you finish, the platform runs these commands in this worktree. All must pass:",
    "",
    validation,
    "",
    "## Handoff",
    "",
    "Finish with a handoff: a short summary, the concrete changes, decisions you made (and why), known issues, and remaining work.",
    "",
  ].join("\n");
}

function reworkBrief(rework: NonNullable<ClaimResponse["rework"]>): string {
  const failed = (rework.validation?.steps ?? []).filter((s) => !s.passed);
  return [
    `# Rework after attempt ${rework.attempt}`,
    "",
    `The previous attempt was rejected: ${rework.reason}.`,
    "Fix the cause, keep the work that was correct, and make sure the validation passes.",
    "",
    ...failed.flatMap((s) => [
      `## ${s.name} — exit code ${s.exitCode ?? "none"}`,
      "",
      `Command: \`${s.command}\``,
      "",
      "```text",
      s.outputTail,
      "```",
      "",
    ]),
  ].join("\n");
}

/** Context files for the agent, written into the worktree before it starts. */
export function contextFiles(claim: ClaimResponse): WorkspaceFile[] {
  const files: WorkspaceFile[] = [{ path: `${CONTEXT_DIR}/TASK.md`, content: taskBrief(claim), mergeJson: false }];
  if (claim.rework) {
    files.push({ path: `${CONTEXT_DIR}/REWORK.md`, content: reworkBrief(claim.rework), mergeJson: false });
  }
  return files;
}

/** The prompt given to the agent. The details live in the context files. */
export function buildPrompt(claim: ClaimResponse, resuming: boolean): string {
  const parts: string[] = [];
  if (resuming && !claim.rework) {
    parts.push(
      "Your previous run on this task was interrupted before it finished. " +
        "Check the current state of the workspace, then continue and complete the task.",
    );
  }
  if (claim.rework) {
    parts.push(
      `Your previous attempt failed (${claim.rework.reason}). ` +
        `Read ${CONTEXT_DIR}/REWORK.md for the failing output, fix the problem and finish the task.`,
    );
  }
  parts.push(claim.task.objective);
  parts.push(
    `The full task brief, rules and the validation that will be run are in ${CONTEXT_DIR}/TASK.md; read it first. ` +
      "Do not commit or push. End with the handoff (summary, changes, decisions, known issues, remaining work).",
  );
  return parts.join("\n\n");
}
