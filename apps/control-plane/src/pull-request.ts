import { type Handoff, isCiConfigPath, type TaskDto, type ValidationReport } from "@mar/core";

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "_None._");

/** Pull request description built from the task, the agent's handoff and validation results. */
export function pullRequestBody(input: {
  task: TaskDto;
  handoff: Handoff | undefined;
  validation: ValidationReport | undefined;
  changedFiles: string[];
}): string {
  const { task, handoff, validation, changedFiles } = input;
  const sections = [`## ${task.key}: ${task.title}`];
  const ciFiles = changedFiles.filter(isCiConfigPath);
  if (ciFiles.length) {
    sections.push(
      `> [!WARNING]\n> This change modifies CI configuration (${ciFiles.map((f) => `\`${f}\``).join(", ")}). Check that it does not weaken a check.`,
    );
  }
  sections.push("### Objective", task.objective);

  if (handoff) {
    sections.push(
      "### Summary",
      handoff.summary,
      "### Changes",
      list(handoff.changes),
      "### Decisions",
      list(handoff.decisions),
      "### Known issues",
      list(handoff.knownIssues),
      "### Remaining work",
      list(handoff.remainingWork),
    );
  }

  if (validation) {
    const rows = validation.steps.map(
      (s) => `| ${s.name} | \`${s.command}\` | ${s.passed ? "✅ pass" : `❌ exit ${s.exitCode}`} | ${Math.round(s.durationMs / 100) / 10}s |`,
    );
    sections.push(
      "### Validation",
      rows.length ? ["| Step | Command | Result | Time |", "|---|---|---|---|", ...rows].join("\n") : "_No validation steps configured._",
    );
  }

  sections.push("### Changed files", list(changedFiles.map((f) => `\`${f}\``)));
  sections.push(`---\nOpened by multi-agent-runtime · agent \`${task.agent}\``);
  return sections.join("\n\n");
}
