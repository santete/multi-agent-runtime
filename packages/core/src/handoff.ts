/**
 * Handoff artifact (spec §45, §62): what every agent must report when it
 * finishes a task. Requested from the agent as structured output
 * (`--json-schema`), stored as an artifact, and fed to the next agent.
 */
export interface Handoff {
  /** What was done and why, in a few sentences. */
  summary: string;
  /** Concrete changes (files, behaviour). */
  changes: string[];
  /** Decisions taken and their rationale. */
  decisions: string[];
  /** Known issues, risks or shortcuts. */
  knownIssues: string[];
  /** What is left for a follow-up task. */
  remainingWork: string[];
}

export const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was done and why, in a few sentences." },
    changes: { type: "array", items: { type: "string" }, description: "Concrete changes (files, behaviour)." },
    decisions: { type: "array", items: { type: "string" }, description: "Decisions taken and their rationale." },
    knownIssues: { type: "array", items: { type: "string" }, description: "Known issues, risks or shortcuts." },
    remainingWork: { type: "array", items: { type: "string" }, description: "Work left for a follow-up task." },
  },
  required: ["summary", "changes", "decisions", "knownIssues", "remainingWork"],
  additionalProperties: false,
} as const;

const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Normalizes an agent's final result into a Handoff. Agents that ignored the
 * schema (or adapters without structured output) still yield a summary.
 */
export function toHandoff(result: unknown): Handoff {
  let value = result;
  if (typeof result === "string") {
    try {
      value = JSON.parse(result);
    } catch {
      return { summary: result, changes: [], decisions: [], knownIssues: [], remainingWork: [] };
    }
  }
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    summary: typeof o.summary === "string" ? o.summary : JSON.stringify(value ?? null),
    changes: stringArray(o.changes),
    decisions: stringArray(o.decisions),
    knownIssues: stringArray(o.knownIssues),
    remainingWork: stringArray(o.remainingWork),
  };
}
