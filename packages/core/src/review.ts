/**
 * Agent code review (spec §30): another agent reviews a delivered task and
 * answers with this structure.
 */
export type ReviewVerdict = "approve" | "request_changes";
export type FindingSeverity = "blocker" | "major" | "minor" | "nit";

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string;
  /** Line in the new version of the file, when it applies. */
  line: number | null;
  message: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes"],
      description: "request_changes only for correctness, security or significant maintainability problems.",
    },
    summary: { type: "string", description: "Overall assessment in a few sentences." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          message: { type: "string", description: "What is wrong and how to fix it." },
        },
        required: ["severity", "file", "line", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

const SEVERITIES: FindingSeverity[] = ["blocker", "major", "minor", "nit"];

/**
 * Normalizes a reviewer's final result. Anything unusable counts as a failed
 * review (null) rather than an approval.
 */
export function toReviewResult(result: unknown): ReviewResult | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.verdict !== "approve" && o.verdict !== "request_changes") return null;
  const findings = (Array.isArray(o.findings) ? o.findings : []).flatMap((f): ReviewFinding[] => {
    if (!f || typeof f !== "object") return [];
    const r = f as Record<string, unknown>;
    return [
      {
        severity: SEVERITIES.includes(r.severity as FindingSeverity) ? (r.severity as FindingSeverity) : "minor",
        file: typeof r.file === "string" ? r.file : "",
        line: typeof r.line === "number" ? r.line : null,
        message: typeof r.message === "string" ? r.message : "",
      },
    ];
  });
  return { verdict: o.verdict, summary: typeof o.summary === "string" ? o.summary : "", findings };
}

/** The review as a comment for the pull request, the task timeline and the rework brief. */
export function formatReview(review: ReviewResult, reviewer: string): string {
  const lines = [`Review by ${reviewer}: ${review.verdict === "approve" ? "approved" : "changes requested"}.`, "", review.summary];
  if (review.findings.length) {
    lines.push("", "Findings:");
    for (const f of review.findings) {
      lines.push(`- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`);
    }
  }
  return lines.join("\n");
}
