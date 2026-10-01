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

  // Spec §48: secret values never leave this machine. The control plane gets the
  // call without them, and is told when the call carried one (it never runs).
  const secrets = (process.env.MAR_SECRET_NAMES ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => ({ name, value: process.env[name] ?? "" }))
    .filter((s) => s.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length)
    // As the value appears inside the JSON text.
    .map((s) => ({ ...s, value: JSON.stringify(s.value).slice(1, -1) }));
  let input = JSON.stringify(call.input ?? {});
  const leaked = secrets.find((s) => input.includes(s.value));
  for (const s of secrets) input = input.split(s.value).join(`[secret ${s.name}]`);

  // Ride out a short control plane outage (e.g. a restart) before failing
  // closed; the agents' hook timeout (120 s) is longer than this budget.
  const budgetMs = Number(process.env.MAR_POLICY_HOOK_BUDGET_MS ?? 90_000);
  const deadline = Date.now() + budgetMs;
  let delay = 500;
  let lastProblem = "";
  for (;;) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/executions/${id}/tool-check`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mar-execution-token": token,
          // Set by the runner when tracing is on: the check joins the execution's trace.
          ...(process.env.TRACEPARENT && { traceparent: process.env.TRACEPARENT }),
        },
        body: JSON.stringify({ tool: call.tool, input: JSON.parse(input), ...(leaked && { containsSecret: leaked.name }) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const verdict = await res.json();
        return { decision: verdict.decision === "allow" ? "allow" : "deny", reason: `[${verdict.risk}] ${verdict.reason}` };
      }
      // 4xx is a real answer (e.g. a revoked execution token): do not retry.
      if (res.status < 500) return { decision: "deny", reason: `policy service returned HTTP ${res.status}` };
      lastProblem = `HTTP ${res.status}`;
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + delay > deadline) {
      return { decision: "deny", reason: `policy hook error: policy service unavailable (${lastProblem})` };
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
}

let result;
try {
  result = await decide();
} catch (err) {
  result = { decision: "deny", reason: `policy hook error: ${err instanceof Error ? err.message : String(err)}` };
}
const format = (DIALECTS[dialect] ?? DIALECTS.json).format;
process.stdout.write(JSON.stringify(format(result.decision, result.reason)));
