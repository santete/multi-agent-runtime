/**
 * Agent routing (spec §25, §38): picks the agent for a task from the agents a
 * runner offers, by capability, measured reliability, cost and load — never a
 * hard-coded "language => vendor" rule.
 */
export type CostTier = "low" | "medium" | "high";
export type RoutingPolicy = "balanced" | "reliability" | "cost" | "speed";

export interface RoutingCandidate {
  id: string;
  skills: string[];
  cost: CostTier;
}

/** Measured execution history of an agent (spec §40). */
export interface AgentStats {
  agent: string;
  executions: number;
  succeeded: number;
  failed: number;
  /** Executions currently running. */
  active: number;
  avgDurationMs: number | null;
  /** Share of delivered work sent back by validation or review. */
  reworkRate: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Known spend (reported or estimated), USD. */
  costUsd?: number;
  /** Validations of the agent's work, and how many passed. */
  validations?: number;
  validationsPassed?: number;
  /** Reviews (human or agent) of the agent's delivered work, and how many asked for changes. */
  reviews?: number;
  reviewRejections?: number;
  /** Executions that needed a person: a blocked action to approve. */
  humanInterventions?: number;
  /** Tasks the agent finished last: merged, or given up on (BLOCKED). */
  tasksMerged?: number;
  tasksBlocked?: number;
}

/** How an agent did on tasks needing one skill (spec §40: measured on the project, not benchmarks). */
export interface AgentSkillStats {
  agent: string;
  skill: string;
  succeeded: number;
  failed: number;
  /** Delivered work sent back by validation or review. */
  reworked: number;
}

export interface RoutingRequest {
  requires: string[];
  /** Agents that failed this task and must not get it again. */
  excluded: string[];
}

export interface RoutingChoice {
  agent: string;
  score: number;
  reason: string;
}

const COST_VALUE: Record<CostTier, number> = { low: 0, medium: 0.5, high: 1 };
const WEIGHTS: Record<RoutingPolicy, { reliability: number; cost: number; load: number; speed: number }> = {
  balanced: { reliability: 1, cost: 0.4, load: 0.2, speed: 0.1 },
  reliability: { reliability: 1, cost: 0.1, load: 0.1, speed: 0 },
  cost: { reliability: 0.4, cost: 1, load: 0.2, speed: 0 },
  speed: { reliability: 0.6, cost: 0.1, load: 0.3, speed: 1 },
};
/** How strongly the agent's overall record anchors a skill record with few runs. */
const SKILL_PRIOR_WEIGHT = 3;
/** Prior for agents without history: optimistic enough to get tried. */
const PRIOR_SUCCESS = 0.8;
const PRIOR_WEIGHT = 2;

const normalize = (s: string) => s.trim().toLowerCase();

export function hasSkills(candidate: RoutingCandidate, requires: string[]): boolean {
  const skills = new Set(candidate.skills.map(normalize));
  return requires.every((r) => skills.has(normalize(r)));
}

/** Success rate smoothed towards the prior, so one lucky run does not dominate. */
export function reliabilityOf(stats: AgentStats | undefined): number {
  const done = (stats?.succeeded ?? 0) + (stats?.failed ?? 0);
  return ((stats?.succeeded ?? 0) + PRIOR_SUCCESS * PRIOR_WEIGHT) / (done + PRIOR_WEIGHT);
}

/**
 * The agent's success on the skills the task needs, anchored to its overall
 * record so a couple of runs on a skill do not decide alone; then discounted
 * for work that came back (rework) and for needing a person.
 */
export function qualityOf(
  stats: AgentStats | undefined,
  skillStats: AgentSkillStats[],
  requires: string[],
): { quality: number; skillRuns: { succeeded: number; done: number } | null } {
  const overall = reliabilityOf(stats);
  const wanted = new Set(requires.map(normalize));
  const relevant = skillStats.filter((x) => x.agent === stats?.agent && wanted.has(normalize(x.skill)));
  let reliability = overall;
  let skillRuns: { succeeded: number; done: number } | null = null;
  if (relevant.length) {
    const succeeded = relevant.reduce((n, x) => n + x.succeeded, 0);
    const done = relevant.reduce((n, x) => n + x.succeeded + x.failed, 0);
    reliability = (succeeded + overall * SKILL_PRIOR_WEIGHT) / (done + SKILL_PRIOR_WEIGHT);
    skillRuns = { succeeded, done };
  }
  const humanRate = stats?.executions ? (stats.humanInterventions ?? 0) / stats.executions : 0;
  const quality = reliability * (1 - 0.5 * (stats?.reworkRate ?? 0)) * (1 - 0.3 * humanRate);
  return { quality, skillRuns };
}

export function chooseAgent(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  stats: AgentStats[],
  policy: RoutingPolicy = "balanced",
  skillStats: AgentSkillStats[] = [],
): RoutingChoice | null {
  const excluded = new Set(request.excluded);
  const eligible = candidates.filter((c) => !excluded.has(c.id) && hasSkills(c, request.requires));
  if (!eligible.length) return null;
  const w = WEIGHTS[policy];
  // Speed relative to the slowest eligible agent with a known average.
  const durations = eligible.map((c) => stats.find((x) => x.agent === c.id)?.avgDurationMs ?? null);
  const slowest = Math.max(1, ...durations.filter((d): d is number => d !== null));
  const scored = eligible.map((c, i) => {
    const s = stats.find((x) => x.agent === c.id);
    const { quality, skillRuns } = qualityOf(s ?? ({ agent: c.id } as AgentStats), skillStats, request.requires);
    const load = Math.min(s?.active ?? 0, 5) / 5;
    const slowness = durations[i] === null ? 0.5 : durations[i]! / slowest;
    const score = w.reliability * quality - w.cost * COST_VALUE[c.cost] - w.load * load - w.speed * slowness;
    return {
      agent: c.id,
      score: Math.round(score * 1000) / 1000,
      reason:
        `${policy}: reliability ${Math.round(quality * 100)}%` +
        ` (${s?.succeeded ?? 0}/${(s?.succeeded ?? 0) + (s?.failed ?? 0)} runs` +
        (skillRuns ? `; ${skillRuns.succeeded}/${skillRuns.done} on ${request.requires.join(", ")}` : "") +
        (s?.reworkRate ? `; ${Math.round(s.reworkRate * 100)}% reworked` : "") +
        `), cost ${c.cost}, ${s?.active ?? 0} running` +
        (durations[i] !== null && w.speed ? `, avg ${Math.round(durations[i]! / 1000)}s` : "") +
        (request.requires.length ? `, has ${request.requires.join(", ")}` : ""),
    };
  });
  // Deterministic: highest score, then the cheaper id order as given.
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!;
}

/** Failures that say the agent itself is unavailable, not that the task is hard. */
export function isAgentUnavailable(reason: string): boolean {
  return /quota|rate.?limit|usage limit|credit|unauthori[sz]ed|not logged in|login required|overloaded|503|capacity/i.test(reason);
}
