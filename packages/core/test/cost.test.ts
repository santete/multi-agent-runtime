import { describe, expect, it } from "vitest";
import { cooldownUntil, DEFAULT_COOLDOWN_MINUTES, executionCost } from "../src/index.js";

const completed = (extra: object) =>
  ({ kind: "completed", sessionId: "s", success: true, deniedActions: [], result: null, ...extra }) as const;

describe("executionCost", () => {
  it("prefers the cost the agent reports", () => {
    expect(executionCost(completed({ costUsd: 0.3, usage: { inputTokens: 10, outputTokens: 20 } }), { inputPerMTok: 1, outputPerMTok: 1 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.3,
      estimated: false,
    });
  });

  it("estimates from tokens and pricing otherwise", () => {
    expect(executionCost(completed({ usage: { inputTokens: 2_000_000, outputTokens: 100_000 } }), { inputPerMTok: 1.25, outputPerMTok: 10 })).toEqual({
      inputTokens: 2_000_000,
      outputTokens: 100_000,
      costUsd: 3.5,
      estimated: true,
    });
  });

  it("knows nothing without usage or pricing", () => {
    expect(executionCost(completed({ usage: { inputTokens: 5, outputTokens: 5 } }))).toMatchObject({ costUsd: null, estimated: false });
    expect(executionCost({ kind: "failed", reason: "boom" }, { inputPerMTok: 1, outputPerMTok: 1 })).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      estimated: false,
    });
  });
});

describe("cooldownUntil", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const minutesLater = (d: Date) => Math.round((d.getTime() - now.getTime()) / 60_000);

  it("reads relative delays", () => {
    expect(minutesLater(cooldownUntil("Rate limited, try again in 2 hours", now))).toBe(120);
    expect(minutesLater(cooldownUntil("retry after 90 seconds", now))).toBe(2);
    expect(minutesLater(cooldownUntil("quota exceeded; try again in 15 min", now))).toBe(15);
  });

  it("reads absolute reset times", () => {
    expect(cooldownUntil("usage limit; resets at 2026-10-01T15:30:00Z", now).toISOString()).toBe("2026-10-01T15:30:00.000Z");
    const clock = cooldownUntil("Claude AI usage limit reached. Your limit resets at 3pm", now);
    expect(clock.getHours()).toBe(15);
    expect(clock.getTime()).toBeGreaterThan(now.getTime());
  });

  it("falls back to a default rest and ignores absurd values", () => {
    expect(minutesLater(cooldownUntil("You've hit your usage limit", now))).toBe(DEFAULT_COOLDOWN_MINUTES);
    expect(minutesLater(cooldownUntil("try again in 90 days", now))).toBe(DEFAULT_COOLDOWN_MINUTES);
  });
});
