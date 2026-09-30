import { type ClaimResponse, type WorkspaceFile, toHandoff } from "@mar/core";

/** Where the runner puts task context for the agent (git-excluded). */
export const CONTEXT_DIR = ".orchestrator/context";
export const KNOWLEDGE_FILE = `${CONTEXT_DIR}/KNOWLEDGE.md`;

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
    "Also report in `knowledge` any durable fact about the project you had to work out and the next agent should not have to rediscover",
    "(architecture, business rules, API contracts, data model, conventions, decisions, known issues). Not a description of your change;",
    `leave it empty when ${KNOWLEDGE_FILE} already covers it. Facts are shared with later tasks once your work is merged.`,
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
    case "ci": {
      const checks = rework.checks ?? [];
      return [
        ...header,
        "The pull request's CI checks failed. Reproduce the failures locally, fix their cause, and make sure the validation still passes.",
        "Fix the code, not the checks: do not change the CI configuration or weaken a check to make it pass. If a check itself looks wrong, say so in your handoff instead.",
        "",
        ...checks.flatMap((c) => [
          `## ${c.name}${c.url ? ` — ${c.url}` : ""}`,
          "",
          c.summary ? c.summary.split("\n").map((l) => `> ${l}`).join("\n") : "> _The check gave no details; see its page._",
          "",
        ]),
      ].join("\n");
    }
    case "base_changed":
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

export function buildReviewPrompt(target: NonNullable<ClaimResponse["review"]>, claim?: ClaimResponse): string {
  return [
    `You are reviewing another agent's change for ${target.taskKey} ("${target.title}").`,
    `Read ${CONTEXT_DIR}/REVIEW.md and the diff in ${CONTEXT_DIR}/DIFF.patch, inspect the code as needed, and do not modify any file.` +
      (claim ? knowledgeHint(claim) : ""),
    "Answer with your verdict (approve or request_changes), a short summary and your findings.",
  ].join("\n\n");
}

function planBrief(plan: NonNullable<ClaimResponse["plan"]>): string {
  const agents = plan.agents.length
    ? plan.agents.map((a) => `- \`${a.id}\`${a.skills.length ? ` — skills: ${a.skills.join(", ")}` : ""}${a.cost ? `; cost ${a.cost}` : ""}`).join("\n")
    : "- _No agent registered; leave `agent` null._";
  const open = plan.openTasks.length ? plan.openTasks.map((t) => `- \`${t.key}\` ${t.title} (${t.state.toLowerCase()})`).join("\n") : "- _None._";
  const previous = plan.previous
    ? [
        "## Revision",
        "",
        "A human reviewed an earlier proposal and asked for changes:",
        "",
        plan.previous.feedback.split("\n").map((l) => `> ${l}`).join("\n"),
        "",
        "The earlier proposal:",
        "",
        "```json",
        JSON.stringify(plan.previous.proposal, null, 2),
        "```",
        "",
      ]
    : [];
  return [
    "# Plan the work for this goal",
    "",
    plan.goal,
    "",
    ...previous,
    "## Available agents",
    "",
    agents,
    "",
    "## Unfinished tasks of the project",
    "",
    "A planned task may depend on one of these by its key.",
    "",
    open,
    "",
    "## How to plan",
    "",
    `- This worktree is a checkout of \`${plan.baseBranch}\`. Read the code to ground the plan in what exists; do **not** modify anything.`,
    "- Break the goal into tasks that one agent can finish in one session and that are reviewable as one pull request.",
    "- Each objective must stand on its own: the agent sees only its task, the handoffs of the tasks it depends on and the code.",
    "- Add a dependency only when a task needs another one's merged result; independent tasks run in parallel.",
    "- Set `agent` to one of the available agents when it clearly fits, otherwise null with the skills in `requires`.",
    "- Refs are short ids (T1, T2, …) used in `dependsOn`; a dependency on an unfinished task above uses its key.",
    "- Do not plan work that is already done, and do not create tasks for reviewing or merging: the platform does that.",
    "- If nothing is left to do, return no tasks and explain why in the summary.",
    "",
  ].join("\n");
}

const KIND_TITLES: Record<string, string> = {
  architecture: "Architecture",
  business_rule: "Business rules",
  api_contract: "API contracts",
  data_model: "Data model",
  convention: "Conventions",
  decision: "Decisions",
  known_issue: "Known issues",
};

/** The project's accepted knowledge, grouped by kind (spec §20). */
export function knowledgeBrief(knowledge: NonNullable<ClaimResponse["knowledge"]>): string {
  const lines = [
    "# Project knowledge",
    "",
    "Facts about this project that the team (agents and people) has established. Rely on them instead of re-analysing the project;",
    "if you find one is wrong or outdated, say so in your handoff's `knowledge` with the corrected fact.",
    "",
  ];
  for (const kind of Object.keys(KIND_TITLES)) {
    const entries = knowledge.filter((k) => k.kind === kind);
    if (!entries.length) continue;
    lines.push(`## ${KIND_TITLES[kind]}`, "");
    for (const k of entries) lines.push(`### ${k.title}${k.source ? ` (from ${k.source})` : ""}`, "", k.body, "");
  }
  return lines.join("\n");
}

/** KNOWLEDGE.md for any task kind, when the project has accepted knowledge. */
export function knowledgeFiles(claim: ClaimResponse): WorkspaceFile[] {
  return claim.knowledge?.length ? [{ path: KNOWLEDGE_FILE, content: knowledgeBrief(claim.knowledge), mergeJson: false }] : [];
}

/** The sentence pointing the agent at the knowledge file. */
function knowledgeHint(claim: ClaimResponse): string {
  return claim.knowledge?.length ? ` What the team already knows about the project is in ${KNOWLEDGE_FILE}.` : "";
}

/** Context file for a plan task. */
export function planFiles(plan: NonNullable<ClaimResponse["plan"]>): WorkspaceFile[] {
  return [{ path: `${CONTEXT_DIR}/PLAN.md`, content: planBrief(plan), mergeJson: false }];
}

export function buildPlanPrompt(plan: NonNullable<ClaimResponse["plan"]>, structured: boolean, claim?: ClaimResponse): string {
  return [
    `You are planning work for a team of coding agents. Read ${CONTEXT_DIR}/PLAN.md, inspect the repository as needed, and do not modify any file.` +
      (claim ? knowledgeHint(claim) : ""),
    "Answer with a summary, the list of tasks (ref, title, objective, agent, requires, dependsOn) and any durable project facts you established (knowledge).",
    ...(structured ? [] : ['Reply with only that JSON object: {"summary": ..., "tasks": [...], "knowledge": [...]}.']),
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
    `The full task brief, rules and the validation that will be run are in ${CONTEXT_DIR}/TASK.md; read it first.${extra}${knowledgeHint(claim)} ` +
      "Do not commit or push. End with the handoff (summary, changes, decisions, known issues, remaining work).",
  );
  return parts.join("\n\n");
}
