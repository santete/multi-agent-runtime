import { type ClaimResponse, type WorkspaceFile, toHandoff } from "@mar/core";

/** Where the runner puts task context for the agent (git-excluded). */
export const CONTEXT_DIR = ".orchestrator/context";

export interface ContextExtras {
  /** Files left conflicted after the runner merged the base branch in. */
  conflicts?: string[];
}

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- _None._");

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
    "- Every tool call is checked by the platform policy. Risky actions need a human approval: if one is denied as requiring approval, continue with what you can do and mention it in your handoff.",
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

function dependenciesBrief(deps: NonNullable<ClaimResponse["dependencies"]>): string {
  return [
    "# Completed tasks this one builds on",
    "",
    "Their changes are already merged into the base branch of this worktree. Reuse their decisions; do not redo their work.",
    "",
    ...deps.flatMap((d) => {
      const h = d.handoff ? toHandoff(d.handoff) : undefined;
      return [
        `## ${d.key}: ${d.title}`,
        "",
        h ? h.summary : "_No handoff recorded._",
        ...(h
          ? ["", "**Changes**", bullets(h.changes), "", "**Decisions**", bullets(h.decisions), "", "**Known issues**", bullets(h.knownIssues)]
          : []),
        "",
      ];
    }),
  ].join("\n");
}

function reworkBrief(rework: NonNullable<ClaimResponse["rework"]>, extras: ContextExtras): string {
  const header = [`# Rework after attempt ${rework.attempt}`, "", `The previous attempt was rejected: ${rework.reason}.`, ""];
  switch (rework.kind) {
    case "validation": {
      const failed = (rework.validation?.steps ?? []).filter((s) => !s.passed);
      return [
        ...header,
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
    case "review":
      return [
        ...header,
        "A reviewer looked at the pull request and asked for changes:",
        "",
        rework.comment ? rework.comment.split("\n").map((l) => `> ${l}`).join("\n") : "> _No comment given._",
        "",
        "Address the feedback, keep the rest of the work, and make sure the validation still passes.",
        "",
      ].join("\n");
    case "merge_conflict": {
      const conflicts = extras.conflicts ?? [];
      return [
        ...header,
        `The platform has merged the latest \`${rework.baseBranch}\` into this worktree.`,
        conflicts.length
          ? "These files have merge conflicts. Resolve every conflict marker, keeping both the base branch's changes and the intent of this task:"
          : "The merge applied cleanly. Check that the task still works on top of the new base.",
        "",
        ...(conflicts.length ? [bullets(conflicts.map((c) => `\`${c}\``)), ""] : []),
        "Do not commit; the platform concludes the merge when it delivers.",
        "",
      ].join("\n");
    }
  }
}

function approvalsBrief(approvals: NonNullable<ClaimResponse["approvals"]>): string {
  return [
    "# Human decisions on blocked actions",
    "",
    "A human reviewed the actions the previous attempt was not allowed to take:",
    "",
    ...approvals.map(
      (a) =>
        `- **${a.status.toUpperCase()}**: \`${a.summary}\`${a.comment ? ` — ${a.comment}` : ""}` +
        (a.status === "approved" ? " (you may run exactly this now)" : " (do not attempt it again; find another way or report it)"),
    ),
    "",
  ].join("\n");
}

function reviewBrief(target: NonNullable<ClaimResponse["review"]>): string {
  const h = target.handoff ? toHandoff(target.handoff) : undefined;
  const validation = target.validation
    ? target.validation.steps.map((s) => `- ${s.passed ? "✓" : "✗"} **${s.name}** \`${s.command}\``).join("\n") || "- _No steps configured._"
    : "- _Not validated._";
  return [
    `# Review ${target.taskKey}: ${target.title}`,
    "",
    `Written by the \`${target.author}\` agent on branch \`${target.branch}\`${target.pullRequestUrl ? ` (${target.pullRequestUrl})` : ""}. This worktree is a checkout of that branch.`,
    "",
    "## What the change had to do",
    "",
    target.objective,
    "",
    "## What the author reports",
    "",
    h ? h.summary : "_No handoff._",
    ...(h ? ["", "**Decisions**", bullets(h.decisions), "", "**Known issues**", bullets(h.knownIssues)] : []),
    "",
    "## Validation (already run by the platform)",
    "",
    validation,
    "",
    "## The change",
    "",
    `The full diff against \`${target.baseBranch}\` is in \`${CONTEXT_DIR}/DIFF.patch\`. Read the changed files around it as needed.`,
    "",
    "## Your job",
    "",
    "- Review for correctness (does it do what the objective asks, edge cases), security, tests and maintainability.",
    "- Do **not** modify any file; only report.",
    "- `request_changes` only for real problems (bugs, missing requirements, security, significant maintainability issues). Style nits alone are not a reason.",
    "- Give each finding a severity (blocker, major, minor, nit), the file, the line when it applies, and how to fix it.",
    "",
  ].join("\n");
}

/** Context files for a review task: the brief and the diff. */
export function reviewFiles(target: NonNullable<ClaimResponse["review"]>, diff: string): WorkspaceFile[] {
  return [
    { path: `${CONTEXT_DIR}/REVIEW.md`, content: reviewBrief(target), mergeJson: false },
    { path: `${CONTEXT_DIR}/DIFF.patch`, content: diff || "(no changes)\n", mergeJson: false },
  ];
}

export function buildReviewPrompt(target: NonNullable<ClaimResponse["review"]>): string {
  return [
    `You are reviewing another agent's change for ${target.taskKey} ("${target.title}").`,
    `Read ${CONTEXT_DIR}/REVIEW.md and the diff in ${CONTEXT_DIR}/DIFF.patch, inspect the code as needed, and do not modify any file.`,
    "Answer with your verdict (approve or request_changes), a short summary and your findings.",
  ].join("\n\n");
}

/** Context files for the agent, written into the worktree before it starts. */
export function contextFiles(claim: ClaimResponse, extras: ContextExtras = {}): WorkspaceFile[] {
  const file = (name: string, content: string): WorkspaceFile => ({ path: `${CONTEXT_DIR}/${name}`, content, mergeJson: false });
  const files = [file("TASK.md", taskBrief(claim))];
  if (claim.dependencies?.length) files.push(file("DEPENDENCIES.md", dependenciesBrief(claim.dependencies)));
  if (claim.rework) files.push(file("REWORK.md", reworkBrief(claim.rework, extras)));
  if (claim.approvals?.length) files.push(file("APPROVALS.md", approvalsBrief(claim.approvals)));
  return files;
}

/** The prompt given to the agent. The details live in the context files. */
export function buildPrompt(claim: ClaimResponse, resuming: boolean): string {
  const parts: string[] = [];
  if (claim.rework) {
    parts.push(
      `Your previous attempt was rejected (${claim.rework.reason}). ` +
        `Read ${CONTEXT_DIR}/REWORK.md, fix the problem and finish the task.`,
    );
  } else if (claim.approvals?.length) {
    parts.push(
      `A human has decided on the actions you were blocked from taking; see ${CONTEXT_DIR}/APPROVALS.md. ` +
        "Continue the task accordingly.",
    );
  } else if (resuming) {
    parts.push(
      "Your previous run on this task was interrupted before it finished. " +
        "Check the current state of the workspace, then continue and complete the task.",
    );
  }
  parts.push(claim.task.objective);
  const extra = claim.dependencies?.length ? ` Tasks it builds on are summarized in ${CONTEXT_DIR}/DEPENDENCIES.md.` : "";
  parts.push(
    `The full task brief, rules and the validation that will be run are in ${CONTEXT_DIR}/TASK.md; read it first.${extra} ` +
      "Do not commit or push. End with the handoff (summary, changes, decisions, known issues, remaining work).",
  );
  return parts.join("\n\n");
}
