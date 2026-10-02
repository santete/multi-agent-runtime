/**
 * Collaboration contract (spec §62): besides its objective, dependencies,
 * validation and executor, every task states what it starts from, its
 * constraints, the expected output and the acceptance criteria it is judged
 * by, and who owns it. Agents report each criterion in their handoff and
 * reviewers check each one (spec §63: "Agent said done" is not enough).
 */
export interface TaskContract {
  /** What the task starts from: documents, decisions, files, data. */
  inputs: string[];
  /** Rules the solution must respect (what not to change, compatibility, performance…). */
  constraints: string[];
  /** The deliverable, in a sentence or two. */
  expectedOutput: string;
  /** Checkable statements that must all hold for the task to be complete. */
  acceptanceCriteria: string[];
}

/** One acceptance criterion as checked by the agent (handoff) or a reviewer. */
export interface CriterionCheck {
  criterion: string;
  met: boolean;
  /** How it was checked: a test, a file, a command output. */
  evidence: string;
}

export const MAX_CRITERIA = 20;

export const CRITERIA_SCHEMA = {
  type: "array",
  description: "One entry per acceptance criterion of the task, in the same order; empty when the task has none.",
  items: {
    type: "object",
    properties: {
      criterion: { type: "string", description: "The acceptance criterion, as stated in the task." },
      met: { type: "boolean" },
      evidence: { type: "string", description: "How you checked it (test, file, command output), or why it is not met." },
    },
    required: ["criterion", "met", "evidence"],
    additionalProperties: false,
  },
} as const;

/** Contract fields of a plan's task (planner structured output). */
export const CONTRACT_SCHEMA_PROPERTIES = {
  inputs: { type: "array", items: { type: "string" }, description: "What the task starts from: documents, decisions, files, data." },
  constraints: {
    type: "array",
    items: { type: "string" },
    description: "Rules the solution must respect (what must not change, compatibility, performance).",
  },
  expectedOutput: { type: "string", description: "The deliverable, in a sentence or two." },
  acceptanceCriteria: {
    type: "array",
    items: { type: "string" },
    description: "Checkable statements that must all hold for the task to be complete (a reviewer checks each).",
  },
} as const;

const strings = (v: unknown, max = 50) =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);

/** A normalized contract from loose input (API body, planner output). */
export function toContract(o: Record<string, unknown>): TaskContract {
  return {
    inputs: strings(o.inputs),
    constraints: strings(o.constraints),
    expectedOutput: typeof o.expectedOutput === "string" ? o.expectedOutput.trim() : "",
    acceptanceCriteria: [...new Set(strings(o.acceptanceCriteria, MAX_CRITERIA))],
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The checks reported for a task's criteria, one per criterion in the task's
 * order. Reports are matched by text (or by position when the wording
 * drifted); a criterion nobody reported is not met.
 */
export function alignChecks(criteria: string[], reported: unknown): CriterionCheck[] {
  const list = (Array.isArray(reported) ? reported : []).flatMap((r): CriterionCheck[] => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    if (typeof o.criterion !== "string") return [];
    return [{ criterion: o.criterion, met: o.met === true, evidence: typeof o.evidence === "string" ? o.evidence : "" }];
  });
  return criteria.map((criterion, i) => {
    const byText = list.find((c) => norm(c.criterion) === norm(criterion));
    const byPosition = list.length === criteria.length ? list[i] : undefined;
    const found = byText ?? byPosition;
    return found ? { criterion, met: found.met, evidence: found.evidence } : { criterion, met: false, evidence: "not reported" };
  });
}
