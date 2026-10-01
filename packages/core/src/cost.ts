/**
 * Cost and quota (spec §39): what an execution cost, and how long an agent
 * that hit its quota should rest.
 */
import type { AgentEvent } from "./adapter.js";

/** List price of an agent's model, to estimate cost when the CLI does not report it. */
export interface Pricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** Spending limits of a project; tasks wait (daily) or stop (per task) when reached. */
export interface Budget {
  dailyUsd?: number | undefined;
  perTaskUsd?: number | undefined;
}

export interface ExecutionCost {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** The cost comes from pricing, not from the agent. */
  estimated: boolean;
}

type Terminal = Extract<AgentEvent, { kind: "completed" | "failed" }>;

/** Reported cost when the agent gives one; otherwise estimated from token usage and pricing. */
export function executionCost(terminal: Terminal, pricing?: Pricing): ExecutionCost {
  const usage = terminal.kind === "completed" ? terminal.usage : undefined;
  const reported = terminal.kind === "completed" ? terminal.costUsd : undefined;
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  if (typeof reported === "number") return { inputTokens, outputTokens, costUsd: reported, estimated: false };
  if (pricing && (inputTokens !== null || outputTokens !== null)) {
    const costUsd = ((inputTokens ?? 0) * pricing.inputPerMTok + (outputTokens ?? 0) * pricing.outputPerMTok) / 1_000_000;
    return { inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6, estimated: true };
  }
  return { inputTokens, outputTokens, costUsd: null, estimated: false };
}

export const DEFAULT_COOLDOWN_MINUTES = 30;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * When an agent that hit its quota can be tried again, read from its error
 * ("try again in 2 hours", "retry after 90 seconds", "resets at 3pm",
 * "resets at 2026-10-01T15:00:00Z"); a default rest otherwise.
 */
export function cooldownUntil(reason: string, now: Date = new Date()): Date {
  const relative = /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/i.exec(reason);
  if (relative) {
    const unit = relative[2]!.toLowerCase().startsWith("mi") || relative[2] === "m" ? "m" : relative[2]![0]!.toLowerCase();
    const ms = Number(relative[1]) * (UNIT_MS[unit] ?? UNIT_MS.m!);
    if (ms > 0 && ms <= 7 * UNIT_MS.d!) return new Date(now.getTime() + ms);
  }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(reason);
  if (iso) {
    const at = new Date(iso[1]!);
    if (at.getTime() > now.getTime() && at.getTime() - now.getTime() <= 7 * UNIT_MS.d!) return at;
  }
  const clock = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(reason);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours < 24 && minutes < 60) {
      // A local clock time on the runner's machine: the next time it comes round.
      const at = new Date(now);
      at.setHours(hours, minutes, 0, 0);
      if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
      return at;
    }
  }
  return new Date(now.getTime() + DEFAULT_COOLDOWN_MINUTES * UNIT_MS.m!);
}
