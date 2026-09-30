// Minimal stand-in for `claude -p --output-format stream-json` used by runner tests.
// Prompt "run: <command>" makes it attempt one Bash call, gated by the PreToolUse
// hook injected through --settings (exactly like Claude Code does).
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const argAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const settings = JSON.parse(argAfter("--settings") ?? "{}");
const resume = argAfter("--resume");

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const sessionId = resume ?? "fake-session-1";
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model" });

const command = /run: (.*)/.exec(prompt)?.[1] ?? "echo hi";
let allowed = true;
let reason = "";
const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
if (hook) {
  const r = spawnSync(hook, {
    shell: true,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: process.env,
  });
  const decision = JSON.parse(r.stdout).hookSpecificOutput;
  allowed = decision.permissionDecision === "allow";
  reason = decision.permissionDecisionReason;
}

out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } });
out({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: !allowed, content: allowed ? "ok" : reason }] },
});
out({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: resume ? `resumed ${resume}` : `ran: ${command}`,
  permission_denials: allowed ? [] : [{ tool_name: "Bash" }],
  total_cost_usd: 0,
});
