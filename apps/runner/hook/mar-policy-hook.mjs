#!/usr/bin/env node
// Platform PreToolUse hook (ADR-0004). Installed by the runner into every agent
// run; asks the control plane whether a tool call is allowed.
//
// Usage: node mar-policy-hook.mjs <dialect>   (dialect: claude | agy | json)
// Env:   MAR_CONTROL_PLANE_URL, MAR_EXECUTION_ID, MAR_EXECUTION_TOKEN
//
// Fails closed: any error denies the call. Plain JS with no dependencies so the
// agent can run it with bare `node`.

const dialect = process.argv[2] ?? "json";

const DIALECTS = {
  claude: {
    parse: (p) => ({ tool: p.tool_name, input: p.tool_input }),
    format: (decision, reason) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    }),
  },
  agy: {
    parse: (p) => ({ tool: p.toolCall?.name, input: p.toolCall?.args }),
    format: (decision, reason) => ({ decision, reason }),
  },
  json: {
    parse: (p) => ({ tool: p.tool, input: p.input }),
    format: (decision, reason) => ({ decision, reason }),
  },
};

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function decide() {
  const d = DIALECTS[dialect];
  if (!d) return { decision: "deny", reason: `policy hook: unknown dialect ${dialect}` };
  const { MAR_CONTROL_PLANE_URL: base, MAR_EXECUTION_ID: id, MAR_EXECUTION_TOKEN: token } = process.env;
  if (!base || !id || !token) return { decision: "deny", reason: "policy hook: missing MAR_* environment" };

  const call = d.parse(JSON.parse(await readStdin()));
  if (!call.tool) return { decision: "deny", reason: "policy hook: could not read the tool call" };

  const res = await fetch(`${base.replace(/\/$/, "")}/executions/${id}/tool-check`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mar-execution-token": token },
    body: JSON.stringify({ tool: call.tool, input: call.input ?? {} }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { decision: "deny", reason: `policy service returned HTTP ${res.status}` };
  const verdict = await res.json();
  const reason = `[${verdict.risk}] ${verdict.reason}`;
  return { decision: verdict.decision === "allow" ? "allow" : "deny", reason };
}

let result;
try {
  result = await decide();
} catch (err) {
  result = { decision: "deny", reason: `policy hook error: ${err instanceof Error ? err.message : String(err)}` };
}
const format = (DIALECTS[dialect] ?? DIALECTS.json).format;
process.stdout.write(JSON.stringify(format(result.decision, result.reason)));
