/**
 * Agent routing (spec §25, §38): picks the agent for a task from the agents a
 * runner offers, by capability, measured reliability, cost and load — never a
 * hard-coded "language => vendor" rule.
 */
export type CostTier = "low" | "medium" | "high";
export type RoutingPolicy = "balanced" | "reliability" | "cost";

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
const WEIGHTS: Record<RoutingPolicy, { reliability: number; cost: number; load: number }> = {
  balanced: { reliability: 1, cost: 0.4, load: 0.2 },
  reliability: { reliability: 1, cost: 0.1, load: 0.1 },
  cost: { reliability: 0.4, cost: 1, load: 0.2 },
};
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

export function chooseAgent(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  stats: AgentStats[],
  policy: RoutingPolicy = "balanced",
): RoutingChoice | null {
  const excluded = new Set(request.excluded);
  const eligible = candidates.filter((c) => !excluded.has(c.id) && hasSkills(c, request.requires));
  if (!eligible.length) return null;
  const w = WEIGHTS[policy];
  const scored = eligible.map((c) => {
    const s = stats.find((x) => x.agent === c.id);
    const reliability = reliabilityOf(s);
    const load = Math.min(s?.active ?? 0, 5) / 5;
    const score = w.reliability * reliability - w.cost * COST_VALUE[c.cost] - w.load * load;
    return {
      agent: c.id,
      score: Math.round(score * 1000) / 1000,
      reason:
        `${policy}: reliability ${Math.round(reliability * 100)}%` +
        ` (${s?.succeeded ?? 0}/${(s?.succeeded ?? 0) + (s?.failed ?? 0)} runs), cost ${c.cost}, ${s?.active ?? 0} running` +
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
