#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` in the user journey test.
// Every tool call goes through the platform's PreToolUse hook (injected with --settings),
// like Claude Code. It answers in the shape the schema asks for:
// - a plan (schema with `tasks`): two tasks, the second depending on the first;
// - a review (schema with `verdict`): approve;
// - work: the objective "write <file>" writes that file, "run: <command>" asks to run a command;
//   the handoff reports every acceptance criterion of TASK.md as met.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const settings = JSON.parse(argAfter("--settings") ?? "{}");
const schema = JSON.parse(argAfter("--json-schema") ?? "{}");
const resume = argAfter("--resume");

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const sessionId = resume ?? `journey-${process.pid}`;
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: sessionId, model: "journey-model" });

const denied = [];
let call = 0;
/** One tool call through the policy hook; returns whether it may run. */
function tool(name, input) {
  const id = `t${++call}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  let allowed = true;
  let reason = "";
  const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (hook) {
    const r = spawnSync(hook, {
      shell: true,
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input }),
      encoding: "utf8",
      env: process.env,
    });
    const decision = JSON.parse(r.stdout).hookSpecificOutput;
    allowed = decision.permissionDecision === "allow";
    reason = decision.permissionDecisionReason;
  }
  if (!allowed) denied.push({ tool_name: name });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !allowed, content: allowed ? "ok" : reason }] } });
  return allowed;
}

const brief = (name) => {
  const path = join(".orchestrator", "context", name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const section = (text, title) => {
  const m = new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
  return m ? m[1] : "";
};

let result;
if (schema.properties?.tasks) {
  tool("Read", { file_path: join(".orchestrator", "context", "PLAN.md") });
  const task = (ref, file, dependsOn) => ({
    ref,
    title: `Write ${file}`,
    objective: `write ${file}`,
    agent: "claude-code",
    requires: [],
    dependsOn,
    paths: [file],
    inputs: [],
    constraints: [],
    expectedOutput: `${file} in the repository root`,
    acceptanceCriteria: [`${file} exists`],
  });
  result = {
    summary: "Two steps: the first file, then the second one.",
    tasks: [task("T1", "plan-a.txt", []), task("T2", "plan-b.txt", ["T1"])],
    knowledge: [],
  };
} else if (schema.properties?.verdict) {
  tool("Read", { file_path: join(".orchestrator", "context", "REVIEW.md") });
  result = { verdict: "approve", summary: "Looks right.", findings: [], criteria: [] };
} else {
  const task = brief("TASK.md");
  const objective = section(task, "Objective").trim() || prompt;
  const command = /run: (.*)/.exec(objective)?.[1];
  const file = /write (\S+)/.exec(objective)?.[1] ?? "journey.txt";
  if (command) {
    tool("Bash", { command });
  } else if (tool("Write", { file_path: join(process.cwd(), file), content: `written for: ${objective}\n` })) {
    writeFileSync(file, `written for: ${objective}\n`);
  }
  const criteria = section(task, "Acceptance criteria")
    .split("\n")
    .map((l) => /^\d+\.\s+(.+)$/.exec(l.trim())?.[1])
    .filter(Boolean)
    .map((criterion) => ({ criterion, met: denied.length === 0, evidence: denied.length ? "the call was refused" : `${file} was written` }));
  result = {
    summary: denied.length ? "Could not finish: a call was refused." : `Wrote ${file}.`,
    changes: denied.length ? [] : [file],
    decisions: [],
    knownIssues: [],
    remainingWork: [],
    knowledge: [],
    openQuestions: [],
    criteria,
  };
}

out({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: JSON.stringify(result),
  structured_output: result,
  permission_denials: denied,
  total_cost_usd: 0,
});
