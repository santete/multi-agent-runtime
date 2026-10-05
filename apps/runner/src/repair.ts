import { type AgentAdapter, type AgentRunRequest, parseJsonAnswer, type TokenUsage } from "@mar/core";
import type { ProcessOutcome } from "./process.js";

export interface UnreadableResult {
  sessionId: string;
  /** Why the answer is not a JSON object, for the agent. */
  error: string;
}

/**
 * A completed run that was asked for structured output but did not answer with
 * a JSON object that has the schema's top-level required fields (agents whose
 * CLI only gets the schema in the prompt), and that can be resumed to fix it.
 */
export function unreadableStructuredResult(request: AgentRunRequest, outcome: ProcessOutcome, adapter: AgentAdapter): UnreadableResult | undefined {
  const t = outcome.terminal;
  if (!request.outputSchema || t.kind !== "completed") return undefined;
  if (!adapter.capabilities.promptedSchema || !adapter.capabilities.resume || !t.sessionId) return undefined;
  const answer = typeof t.result === "string" ? parseJsonAnswer(t.result) : t.result;
  if (!answer || typeof answer !== "object") {
    return { sessionId: t.sessionId, error: typeof t.result === "string" ? jsonError(t.result) : "the answer is not a JSON object" };
  }
  const missing = missingRequired(request.outputSchema, answer);
  // Seen live: a planner answering with the schema itself.
  if (missing.length) return { sessionId: t.sessionId, error: `required fields are missing: ${missing.join(", ")} (send the answer itself, not the schema)` };
  return undefined;
}

/** Top-level required fields of the schema that the answer does not have. */
function missingRequired(schema: object, answer: object): string[] {
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required) || Array.isArray(answer)) return [];
  return required.filter((k): k is string => typeof k === "string" && !(k in answer));
}

function jsonError(text: string): string {
  if (!text.trim()) return "the answer was empty";
  const start = text.indexOf("{");
  if (start < 0) return "the answer contains no JSON object";
  const json = text.slice(start, text.lastIndexOf("}") + 1);
  try {
    JSON.parse(json);
    return "the answer is not a single JSON object";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Show where: models repeat the same mistake when only told that it is invalid.
    const at = Number(/position (\d+)/.exec(message)?.[1]);
    return Number.isFinite(at) ? `${message}, here: …${json.slice(Math.max(0, at - 80), at)}⟨here⟩${json.slice(at, at + 20)}…` : message;
  }
}

export function repairPrompt(error: string): string {
  return (
    `Your final answer could not be read as JSON: ${error}. ` +
    "Reply now with only the corrected JSON object that follows the schema you were given: " +
    "no other text, no code fence, and the same content."
  );
}

const addUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined =>
  a && b
    ? {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        ...((a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) && {
          cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
        }),
      }
    : (a ?? b);

/**
 * The first run with the repaired answer when the repair produced a JSON object;
 * otherwise the first run as it was. Calls denied in either run still count, and
 * usage and cost add up.
 */
export function mergeRepair(first: ProcessOutcome, repair: ProcessOutcome, schema?: object): ProcessOutcome {
  const f = first.terminal;
  const r = repair.terminal;
  if (f.kind !== "completed" || r.kind !== "completed") return first;
  const answer = typeof r.result === "string" ? parseJsonAnswer(r.result) : r.result;
  if (!answer || typeof answer !== "object") return first;
  if (schema && missingRequired(schema, answer).length) return first;
  const deniedActions = [...f.deniedActions, ...r.deniedActions];
  const usage = addUsage(f.usage, r.usage);
  const costUsd = f.costUsd !== undefined || r.costUsd !== undefined ? (f.costUsd ?? 0) + (r.costUsd ?? 0) : undefined;
  return {
    exitCode: first.exitCode,
    terminal: {
      ...f,
      result: answer,
      success: f.success && r.success && deniedActions.length === 0,
      deniedActions,
      ...(usage && { usage }),
      ...(costUsd !== undefined && { costUsd }),
      ...(f.durationMs !== undefined && r.durationMs !== undefined && { durationMs: f.durationMs + r.durationMs }),
    },
  };
}
