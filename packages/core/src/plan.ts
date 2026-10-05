import { HUMAN_EXECUTOR } from "./api.js";
import { CONTRACT_SCHEMA_PROPERTIES, type TaskContract, toContract } from "./contract.js";
import { KNOWLEDGE_NOTE_SCHEMA, type KnowledgeNote, toKnowledgeNotes } from "./knowledge.js";

/**
 * Assisted planning (spec §24): a planner agent breaks a goal into a task DAG
 * and a human approves, edits or sends it back before any task is created.
 */
export interface PlannedTask extends TaskContract {
  /** Short id, unique within the plan, that other planned tasks depend on. */
  ref: string;
  title: string;
  objective: string;
  /** An agent id, or null to let the scheduler route it by `requires`. */
  agent: string | null;
  requires: string[];
  /** Refs of planned tasks, or keys of existing tasks of the project. */
  dependsOn: string[];
  /** Files or globs the task will change (path ownership, spec §27). */
  paths: string[];
}

export interface PlanProposal {
  summary: string;
  tasks: PlannedTask[];
  /** What the planner learned about the project (shared once the plan is approved). */
  knowledge: KnowledgeNote[];
}

export const MAX_PLAN_TASKS = 20;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "How the goal is broken down and why, in a few sentences." },
    tasks: {
      type: "array",
      description: `At most ${MAX_PLAN_TASKS} tasks, each small enough for one agent session and one pull request.`,
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Short unique id such as T1, used in dependsOn." },
          title: { type: "string" },
          objective: {
            type: "string",
            description: "Self-contained instructions for the agent: what to change, where, and how to tell it is done.",
          },
          agent: { type: ["string", "null"], description: "One of the available agent ids, or null to route by requires." },
          requires: { type: "array", items: { type: "string" }, description: "Skills the agent needs (from the available agents)." },
          dependsOn: { type: "array", items: { type: "string" }, description: "Refs of tasks that must be merged first." },
          ...CONTRACT_SCHEMA_PROPERTIES,
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Files or globs the task will change (e.g. src/payments.js, src/export/**); tasks whose paths overlap run one after the other.",
          },
        },
        required: ["ref", "title", "objective", "agent", "requires", "dependsOn", "paths", "inputs", "constraints", "expectedOutput", "acceptanceCriteria"],
        additionalProperties: false,
      },
    },
    knowledge: KNOWLEDGE_NOTE_SCHEMA,
  },
  required: ["summary", "tasks", "knowledge"],
  additionalProperties: false,
} as const;

export type PlanCheck = { ok: true; plan: PlanProposal } | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/**
 * The JSON object in a text answer (agents without structured output): the
 * whole text, a fenced block, or the outermost braces.
 */
export function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const braces = text.includes("{") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : undefined;
  const rest = text.includes("{") ? text.slice(text.indexOf("{")) : undefined;
  for (const candidate of [text, fenced, braces, braces && balanceBrackets(braces), rest && balanceBrackets(rest)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/**
 * Inserts the closing brackets a model left out, outside strings: `["a"}` becomes
 * `["a"]}` and a cut-off answer is closed at the end. Models without an enforced
 * schema make this mistake in long nested answers (seen live: an array of
 * acceptance criteria closed with `}`, the same way in a retry).
 */
export function balanceBrackets(json: string): string {
  const closer: Record<string, string> = { "{": "}", "[": "]" };
  const open: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") {
      // Close what was left open until this bracket matches.
      while (open.length && closer[open.at(-1)!] !== ch) out += closer[open.pop()!];
      open.pop();
    }
    out += ch;
  }
  if (inString) out += '"';
  while (open.length) out += closer[open.pop()!];
  return out;
}

/**
 * Normalizes and checks a proposal (from the planner or edited by a human):
 * unique refs, no dependency cycle, tasks returned in dependency order. A
 * planner may answer with no tasks (nothing to do: allowEmpty); an approval may not.
 * Dependencies that are not refs are kept as references to existing tasks.
 */
export function checkPlan(result: unknown, options: { allowEmpty?: boolean } = {}): PlanCheck {
  let value = result;
  if (typeof value === "string") {
    value = parseJsonAnswer(value);
    if (value === undefined) return { ok: false, error: "the plan is not valid JSON" };
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as any).tasks)) {
    return { ok: false, error: "the plan has no task list" };
  }
  const raw = (value as { tasks: unknown[] }).tasks;
  if (!raw.length && !options.allowEmpty) return { ok: false, error: "the plan has no tasks" };
  if (raw.length > MAX_PLAN_TASKS) return { ok: false, error: `the plan has more than ${MAX_PLAN_TASKS} tasks` };

  const tasks: PlannedTask[] = [];
  for (const [i, t] of raw.entries()) {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    const task: PlannedTask = {
      ref: str(o.ref) || `T${i + 1}`,
      title: str(o.title),
      objective: str(o.objective),
      agent: str(o.agent) || null,
      requires: strings(o.requires),
      dependsOn: [...new Set(strings(o.dependsOn))],
      // A person's task changes nothing in the repository itself, so it owns no paths.
      paths: str(o.agent) === HUMAN_EXECUTOR ? [] : [...new Set(strings(o.paths))].slice(0, 50),
      ...toContract(o),
    };
    if (!task.title || !task.objective) return { ok: false, error: `task ${task.ref} needs a title and an objective` };
    if (tasks.some((x) => x.ref === task.ref)) return { ok: false, error: `duplicate task ref ${task.ref}` };
    if (task.dependsOn.includes(task.ref)) return { ok: false, error: `task ${task.ref} depends on itself` };
    tasks.push(task);
  }

  // Topological order (Kahn), stable with respect to the proposal's order.
  const refs = new Set(tasks.map((t) => t.ref));
  const ordered: PlannedTask[] = [];
  const done = new Set<string>();
  while (ordered.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.ref) && t.dependsOn.every((d) => !refs.has(d) || done.has(d)));
    if (!next) {
      const cyclic = tasks.filter((t) => !done.has(t.ref)).map((t) => t.ref);
      return { ok: false, error: `dependency cycle between ${cyclic.join(", ")}` };
    }
    done.add(next.ref);
    ordered.push(next);
  }
  return {
    ok: true,
    plan: { summary: str((value as any).summary), tasks: ordered, knowledge: toKnowledgeNotes((value as any).knowledge) },
  };
}

/**
 * Multi-agent debate on a plan (spec §53): another agent critiques the
 * proposal before anyone approves it.
 */
export type CritiqueVerdict = "approve" | "revise";

export interface PlanCritique {
  verdict: CritiqueVerdict;
  summary: string;
  issues: Array<{ ref: string | null; severity: "blocker" | "major" | "minor"; message: string }>;
}

export const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "revise"],
      description: "revise only for real problems: missing or wrong work, a wrong dependency, tasks too big for one session, unclear objectives.",
    },
    summary: { type: "string", description: "Overall assessment of the plan in a few sentences." },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "The planned task the issue is about, or null for the whole plan." },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          message: { type: "string", description: "What is wrong and what the planner should change." },
        },
        required: ["ref", "severity", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "issues"],
  additionalProperties: false,
} as const;

/** A critic's answer; anything unusable is null (never an approval). */
export function toPlanCritique(result: unknown): PlanCritique | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.verdict !== "approve" && o.verdict !== "revise") return null;
  const severities = ["blocker", "major", "minor"] as const;
  const issues = (Array.isArray(o.issues) ? o.issues : []).flatMap((i): PlanCritique["issues"] => {
    if (!i || typeof i !== "object") return [];
    const r = i as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message.trim() : "";
    if (!message) return [];
    return [
      {
        ref: typeof r.ref === "string" && r.ref.trim() ? r.ref.trim() : null,
        severity: severities.includes(r.severity as never) ? (r.severity as PlanCritique["issues"][number]["severity"]) : "major",
        message,
      },
    ];
  });
  return { verdict: o.verdict, summary: typeof o.summary === "string" ? o.summary.trim() : "", issues };
}

/** The critique as feedback for the planner's next round. */
export function formatCritique(critique: PlanCritique, critic: string): string {
  const lines = [`Critique by ${critic}: ${critique.verdict === "approve" ? "approve" : "revise"}.`, "", critique.summary];
  if (critique.issues.length) {
    lines.push("", "Issues:");
    for (const i of critique.issues) lines.push(`- [${i.severity}]${i.ref ? ` ${i.ref}:` : ""} ${i.message}`);
  }
  return lines.join("\n");
}
