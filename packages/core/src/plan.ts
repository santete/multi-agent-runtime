/**
 * Assisted planning (spec §24): a planner agent breaks a goal into a task DAG
 * and a human approves, edits or sends it back before any task is created.
 */
export interface PlannedTask {
  /** Short id, unique within the plan, that other planned tasks depend on. */
  ref: string;
  title: string;
  objective: string;
  /** An agent id, or null to let the scheduler route it by `requires`. */
  agent: string | null;
  requires: string[];
  /** Refs of planned tasks, or keys of existing tasks of the project. */
  dependsOn: string[];
}

export interface PlanProposal {
  summary: string;
  tasks: PlannedTask[];
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
        },
        required: ["ref", "title", "objective", "agent", "requires", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "tasks"],
  additionalProperties: false,
} as const;

export type PlanCheck = { ok: true; plan: PlanProposal } | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/**
 * The JSON object in a text answer (agents without structured output): the
 * whole text, a fenced block, or the outermost braces.
 */
function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const braces = text.includes("{") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : undefined;
  for (const candidate of [text, fenced, braces]) {
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
  return { ok: true, plan: { summary: str((value as any).summary), tasks: ordered } };
}
