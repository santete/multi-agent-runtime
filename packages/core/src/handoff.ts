import { CRITERIA_SCHEMA, type CriterionCheck } from "./contract.js";
import { KNOWLEDGE_NOTE_SCHEMA, type KnowledgeNote, toKnowledgeNotes } from "./knowledge.js";

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
  /** Durable project facts for the shared knowledge base (spec §35). */
  knowledge: KnowledgeNote[];
  /** Questions only a person can answer; the task waits for the answers (spec §61). */
  openQuestions: OpenQuestion[];
  /** The agent's own check of each acceptance criterion of the task (spec §62). */
  criteria: CriterionCheck[];
}

export interface OpenQuestion {
  question: string;
  /** Suggested answers, if the choice is between known options. */
  options: string[];
  /** Why it matters / what the agent found. */
  context: string;
}

export const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was done and why, in a few sentences." },
    changes: { type: "array", items: { type: "string" }, description: "Concrete changes (files, behaviour)." },
    decisions: { type: "array", items: { type: "string" }, description: "Decisions taken and their rationale." },
    knownIssues: { type: "array", items: { type: "string" }, description: "Known issues, risks or shortcuts." },
    remainingWork: { type: "array", items: { type: "string" }, description: "Work left for a follow-up task." },
    knowledge: KNOWLEDGE_NOTE_SCHEMA,
    criteria: CRITERIA_SCHEMA,
    openQuestions: {
      type: "array",
      description:
        "Only for a real ambiguity a person must decide (business rule, product choice, missing access) that blocks finishing the task correctly. " +
        "The task waits for the answers and you continue afterwards. Empty when you could decide yourself.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, description: "Suggested answers, if any." },
          context: { type: "string", description: "What you found and why it matters." },
        },
        required: ["question", "options", "context"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "changes", "decisions", "knownIssues", "remainingWork", "knowledge", "openQuestions", "criteria"],
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
      return { summary: result, changes: [], decisions: [], knownIssues: [], remainingWork: [], knowledge: [], openQuestions: [], criteria: [] };
    }
  }
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    summary: typeof o.summary === "string" ? o.summary : JSON.stringify(value ?? null),
    changes: stringArray(o.changes),
    decisions: stringArray(o.decisions),
    knownIssues: stringArray(o.knownIssues),
    remainingWork: stringArray(o.remainingWork),
    knowledge: toKnowledgeNotes(o.knowledge),
    openQuestions: (Array.isArray(o.openQuestions) ? o.openQuestions : [])
      .flatMap((q): OpenQuestion[] => {
        const r = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
        const question = typeof r.question === "string" ? r.question.trim() : "";
        if (!question) return [];
        return [{ question, options: stringArray(r.options).slice(0, 10), context: typeof r.context === "string" ? r.context : "" }];
      })
      .slice(0, 5),
    criteria: (Array.isArray(o.criteria) ? o.criteria : []).flatMap((c): CriterionCheck[] => {
      const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return typeof r.criterion === "string" ? [{ criterion: r.criterion, met: r.met === true, evidence: typeof r.evidence === "string" ? r.evidence : "" }] : [];
    }),
  };
}
