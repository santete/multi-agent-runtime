/**
 * Shared project knowledge (spec §20, §21, §35): durable facts about the
 * project that agents discover while working and every later task reads, so
 * no agent has to analyse the repository from scratch.
 */
export const KNOWLEDGE_KINDS = [
  "architecture",
  "business_rule",
  "api_contract",
  "data_model",
  "convention",
  "decision",
  "known_issue",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * proposed: reported by an agent, not yet trusted; accepted: shared with every
 * task of the project; archived: superseded or wrong.
 */
export type KnowledgeStatus = "proposed" | "accepted" | "archived";

/** What an agent reports (part of its handoff or plan). */
export interface KnowledgeNote {
  kind: KnowledgeKind;
  title: string;
  body: string;
}

export const KNOWLEDGE_NOTE_SCHEMA = {
  type: "array",
  description:
    "Durable facts about the project that later tasks should know (architecture, business rules, API contracts, data model, " +
    "conventions, decisions, known issues). Not a description of this change. Empty when there is nothing new.",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...KNOWLEDGE_KINDS] },
      title: { type: "string", description: "Short name of the fact, e.g. 'Amounts are integer cents'." },
      body: { type: "string", description: "The fact in one to five sentences, with file names where useful." },
    },
    required: ["kind", "title", "body"],
    additionalProperties: false,
  },
} as const;

export const MAX_NOTES_PER_REPORT = 10;

/** Normalizes the knowledge notes of an agent report; drops anything unusable. */
export function toKnowledgeNotes(value: unknown): KnowledgeNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((n): KnowledgeNote[] => {
      if (!n || typeof n !== "object") return [];
      const o = n as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim().slice(0, 200) : "";
      const body = typeof o.body === "string" ? o.body.trim().slice(0, 4000) : "";
      if (!title || !body) return [];
      const kind = KNOWLEDGE_KINDS.includes(o.kind as KnowledgeKind) ? (o.kind as KnowledgeKind) : "decision";
      return [{ kind, title, body }];
    })
    .slice(0, MAX_NOTES_PER_REPORT);
}

/** Same fact? Titles are compared loosely so a restated fact supersedes the old one. */
export function sameKnowledge(a: { kind: string; title: string }, b: { kind: string; title: string }): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return a.kind === b.kind && norm(a.title) === norm(b.title);
}
