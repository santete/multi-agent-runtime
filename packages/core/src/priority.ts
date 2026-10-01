/**
 * Automatic reprioritization (spec §53): the order READY work is taken in is
 * the task's own priority, raised by what waits on it and by how long it has
 * waited — so the critical path and old work are not starved.
 */
export const DEFAULT_PRIORITY = 50;

export interface PriorityInput {
  /** Set by people: 0 (whenever) … 100 (urgent). */
  priority: number;
  /** Tasks that (transitively) cannot start before this one is merged. */
  dependents: number;
  /** Minutes since the task became READY. */
  waitingMinutes: number;
  kind: string;
}

export interface PriorityScore {
  score: number;
  /** Why, e.g. ["priority 50", "+10 unblocks 2 tasks", "+3 waiting 30 min"]. */
  reasons: string[];
}

/** Reviews, critiques and plans unblock people and merges: they go first among equals. */
const UNBLOCKING_KINDS = new Set(["review", "critique", "plan"]);

export function effectivePriority(input: PriorityInput): PriorityScore {
  const reasons = [`priority ${input.priority}`];
  let score = input.priority;
  if (input.dependents > 0) {
    const bonus = Math.min(input.dependents * 5, 30);
    score += bonus;
    reasons.push(`+${bonus} unblocks ${input.dependents} task${input.dependents === 1 ? "" : "s"}`);
  }
  const aging = Math.min(Math.floor(input.waitingMinutes / 10), 20);
  if (aging > 0) {
    score += aging;
    reasons.push(`+${aging} waiting ${Math.round(input.waitingMinutes)} min`);
  }
  if (UNBLOCKING_KINDS.has(input.kind)) {
    score += 10;
    reasons.push(`+10 ${input.kind} unblocks people`);
  }
  return { score, reasons };
}

/** For each task id, how many open tasks depend on it, directly or not. */
export function transitiveDependents(tasks: Array<{ id: string; dependsOn: string[] }>): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) children.set(d, [...(children.get(d) ?? []), t.id]);
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const seen = new Set<string>();
    const stack = [...(children.get(t.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    counts.set(t.id, seen.size);
  }
  return counts;
}
