#!/usr/bin/env node
// PreToolUse hook for the preflight check (apps/runner/src/preflight.ts).
// Agents such as Claude Code and Qoder only run shell commands headlessly when a hook allows them, so the
// preflight installs this one: it allows exactly `node -v` and refuses everything else. There is no
// execution to ask the control plane about, which is why it does not use mar-policy-hook.mjs.
//
// Usage: node mar-preflight-hook.mjs <dialect>   (dialect: claude | agy | json)

const dialect = process.argv[2] ?? "json";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let command = "";
try {
  const call = JSON.parse(raw);
  const input = call.tool_input ?? call.toolInput ?? call.input ?? {};
  command = String(input.command ?? input.CommandLine ?? input.cmd ?? "");
} catch {
  // unreadable: refused below
}

const allowed = /^\s*node(?:\.exe)?\s+(?:-v|--version)\s*$/i.test(command);
const decision = allowed ? "allow" : "deny";
const reason = allowed ? "preflight: node -v" : "preflight: only `node -v` may run";

const output =
  dialect === "claude"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }
    : { decision, reason };
process.stdout.write(JSON.stringify(output));
