import { describe, expect, it } from "vitest";
import { formatReview, toReviewResult } from "../src/index.js";

describe("toReviewResult", () => {
  it("accepts a structured review (object or JSON text)", () => {
    const review = {
      verdict: "request_changes",
      summary: "Subtracts instead of adding.",
      findings: [{ severity: "blocker", file: "math.js", line: 2, message: "use a + b" }],
    };
    expect(toReviewResult(review)).toEqual(review);
    expect(toReviewResult(JSON.stringify(review))).toEqual(review);
  });

  it("normalizes findings and rejects unusable answers instead of approving", () => {
    expect(toReviewResult({ verdict: "approve", summary: "ok", findings: [{ severity: "weird", file: "a" }] })).toEqual({
      verdict: "approve",
      summary: "ok",
      findings: [{ severity: "minor", file: "a", line: null, message: "" }],
    });
    expect(toReviewResult("looks fine to me")).toBeNull();
    expect(toReviewResult({ verdict: "maybe" })).toBeNull();
    expect(toReviewResult(null)).toBeNull();
  });
});

describe("formatReview", () => {
  it("renders the verdict, summary and findings", () => {
    const text = formatReview(
      { verdict: "request_changes", summary: "Bug.", findings: [{ severity: "major", file: "src/a.ts", line: 3, message: "off by one" }] },
      "agent codex",
    );
    expect(text).toBe("Review by agent codex: changes requested.\n\nBug.\n\nFindings:\n- [major] src/a.ts:3 — off by one");
  });
});
