import type { MetricRate, ProductMetrics } from "@mar/core";
import type { Queryable } from "./db.js";

/**
 * Product success metrics (spec §64), computed from the event log, executions
 * and artifacts (ADR-0030). Tasks count once they finished inside the window;
 * executions and artifacts once they were created inside it.
 */

type Row = Record<string, any>;

const rate = (numerator: number, denominator: number): MetricRate => ({
  value: denominator ? numerator / denominator : null,
  numerator,
  denominator,
});
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ms = (d: Date | string) => new Date(d).getTime();

/** What a person did on a task beyond reviewing it: approvals, answers, retries, instructions, pauses, rejections. */
const INTERVENTION_EVENTS = new Set(["ApprovalRequested", "DecisionRequested", "InstructionSent", "TaskPauseRequested"]);

export async function computeMetrics(
  q: Queryable,
  scope: { projectId?: string | undefined; org?: string | undefined; days: number; runnerOnlineSeconds: number },
): Promise<ProductMetrics> {
  const since = new Date(Date.now() - scope.days * 86_400_000);
  const inScope = `($1::uuid is null or t.project_id = $1) and ($2::text is null or t.project_id in (select id from projects where org_id = $2))`;
  const params = [scope.projectId ?? null, scope.org ?? null];

  // Work done by agents: tasks for people (agent "human", spec §61) are not part of what is measured.
  const tasks = await q.query(`select t.* from tasks t where t.kind = 'work' and t.agent <> 'human' and ${inScope}`, params);
  const finished = tasks.filter((t) => ["COMPLETED", "BLOCKED"].includes(t.state) && ms(t.updated_at) >= since.getTime());
  const ids = tasks.map((t) => t.id as string);

  const events = ids.length
    ? await q.query(
        `select task_id, execution_id, type, payload, created_at from events
         where task_id = any($1::uuid[]) and type in ('TaskStateChanged', 'ExecutionAssigned', 'ExecutionStarted',
           'ApprovalRequested', 'DecisionRequested', 'InstructionSent', 'TaskPauseRequested')
         order by seq`,
        [ids],
      )
    : [];
  const byTask = new Map<string, Row[]>();
  for (const e of events) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);

  const executions = await q.query(
    `select e.*, t.kind from executions e join tasks t on t.id = e.task_id where ${inScope}`,
    params,
  );
  const execsByTask = new Map<string, Row[]>();
  for (const x of executions) execsByTask.set(x.task_id, [...(execsByTask.get(x.task_id) ?? []), x]);

  const artifacts = await q.query(
    `select a.type, a.content, a.execution_id, a.task_id, a.created_at from artifacts a join tasks t on t.id = a.task_id
     where a.type in ('handoff', 'validation_result', 'review_result') and a.created_at >= $3 and ${inScope}`,
    [...params, since],
  );
  // Agent reviews carry a `verdict` (and a `decision` too); human reviews only a `decision`.
  const humanReviewed = new Set(
    artifacts.filter((a) => a.type === "review_result" && "decision" in a.content && !("verdict" in a.content)).map((a) => a.task_id),
  );

  const visited = (taskId: string, state: string) =>
    (byTask.get(taskId) ?? []).some((e) => e.type === "TaskStateChanged" && e.payload.to === state);
  const intervened = (taskId: string) =>
    (byTask.get(taskId) ?? []).some(
      (e) =>
        INTERVENTION_EVENTS.has(e.type) ||
        (e.type === "TaskStateChanged" &&
          (e.payload.to === "WAITING_FOR_HUMAN" || e.payload.to === "BLOCKED" || e.payload.reason === "retried by a human")),
    ) || artifacts.some((a) => a.task_id === taskId && a.type === "review_result" && a.content.decision === "reject");
  const completed = finished.filter((t) => t.state === "COMPLETED");

  // ---- engineering
  const validations = artifacts.filter((a) => a.type === "validation_result");
  const reviews = artifacts.filter((a) => a.type === "review_result" && ("decision" in a.content || "verdict" in a.content));
  const completedAt = (t: Row) => {
    const done = (byTask.get(t.id) ?? []).filter((e) => e.type === "TaskStateChanged" && e.payload.to === "COMPLETED").at(-1);
    return ms(done?.created_at ?? t.updated_at);
  };

  // ---- collaboration
  const workExecs = executions.filter(
    (x) => x.kind === "work" && x.finished_at && ms(x.finished_at) >= since.getTime() && !x.revalidation && !["interrupted", "cancelled"].includes(x.status),
  );
  const withHandoff = new Set(
    artifacts.filter((a) => a.type === "handoff" && typeof a.content.summary === "string" && a.content.summary.trim()).map((a) => a.execution_id),
  );
  const assigned = events.filter((e) => e.type === "ExecutionAssigned" && ms(e.created_at) >= since.getTime());
  const contextual = assigned.filter((e) => e.payload.kind === "work" && "knowledge" in e.payload);
  const lastAgent = (taskId: string) =>
    (execsByTask.get(taskId) ?? []).filter((x) => x.agent).sort((a, b) => a.attempt - b.attempt).at(-1)?.agent as string | undefined;
  const handedOver = finished.filter((t) =>
    (t.depends_on ?? []).some((d: string) => {
      const from = lastAgent(d);
      return from && from !== lastAgent(t.id);
    }),
  );

  // ---- reliability
  // The agent or its runner failed (not a failed validation, which is rework).
  const failedOnce = finished.filter((t) =>
    (execsByTask.get(t.id) ?? []).some((x) => x.status === "lost" || (x.status === "failed" && x.result?.kind === "failed")),
  );
  const resumed = assigned
    .filter((e) => e.payload.resumable)
    .map((e) => executions.find((x) => x.id === e.execution_id))
    .filter((x): x is Row => Boolean(x && x.finished_at));
  const recentWorkExecs = executions.filter((x) => x.kind === "work" && x.created_at && ms(x.created_at) >= since.getTime());
  const workspaceFailures = recentWorkExecs.filter((x) => /workspace preparation failed/i.test(String(x.result?.reason ?? "")));

  // ---- platform
  const runners = await q.query(
    `select agents, last_seen_at from runners r where ($1::text is null or r.org_id = $1)`,
    [scope.org ?? null],
  );
  const online = runners.filter((r) => r.last_seen_at && Date.now() - ms(r.last_seen_at) <= scope.runnerOnlineSeconds * 1000);
  const agents = new Set(runners.flatMap((r) => (r.agents ?? []).map((a: { id: string }) => a.id)));
  const [counted] = await q.query<{ projects: number }>(
    `select count(*)::int as projects from projects p where ($1::uuid is null or p.id = $1) and ($2::text is null or p.org_id = $2)`,
    params,
  );
  const active = executions.filter((x) => ["assigned", "running", "validating", "delivering"].includes(x.status)).length;
  // Peak overlap of executions in the window.
  const points = executions
    .filter((x) => x.started_at && ms(x.finished_at ?? new Date()) >= since.getTime())
    .flatMap((x) => [
      { t: Math.max(ms(x.started_at), since.getTime()), d: 1 },
      { t: ms(x.finished_at ?? new Date()), d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let running = 0;
  let peak = 0;
  for (const p of points) peak = Math.max(peak, (running += p.d));

  const queueWaits: number[] = [];
  for (const list of byTask.values()) {
    let ready: number | undefined;
    for (const e of list) {
      if (e.type !== "TaskStateChanged") continue;
      if (e.payload.to === "READY") ready = ms(e.created_at);
      else if (e.payload.to === "ASSIGNED" && ready !== undefined) {
        if (ms(e.created_at) >= since.getTime()) queueWaits.push(ms(e.created_at) - ready);
        ready = undefined;
      }
    }
  }
  const started = new Map(events.filter((e) => e.type === "ExecutionStarted").map((e) => [e.execution_id, ms(e.created_at)]));
  const dispatch = assigned.flatMap((e) => (started.has(e.execution_id) ? [started.get(e.execution_id)! - ms(e.created_at)] : []));

  return {
    since: since.toISOString(),
    days: scope.days,
    collaboration: {
      handoffSuccess: rate(workExecs.filter((x) => withHandoff.has(x.id)).length, workExecs.length),
      contextReuse: rate(contextual.filter((e) => e.payload.knowledge > 0 || e.payload.dependencies > 0).length, contextual.length),
      agentToAgentHandoff: rate(handedOver.filter((t) => t.state === "COMPLETED").length, handedOver.length),
    },
    engineering: {
      taskSuccess: rate(completed.length, finished.length),
      validationPass: rate(validations.filter((a) => a.content.passed === true).length, validations.length),
      rework: rate(finished.filter((t) => visited(t.id, "REWORK")).length, finished.length),
      reviewRejection: rate(reviews.filter((a) => a.content.decision === "reject" || a.content.verdict === "request_changes").length, reviews.length),
      meanCompletionMs: mean(completed.map((t) => completedAt(t) - ms(t.created_at))),
    },
    automation: {
      humanIntervention: rate(finished.filter((t) => intervened(t.id)).length, finished.length),
      autoResolution: (() => {
        const troubled = finished.filter((t) => visited(t.id, "REWORK") || visited(t.id, "RETRYING"));
        return rate(troubled.filter((t) => t.state === "COMPLETED" && !intervened(t.id)).length, troubled.length);
      })(),
      autonomousCompletion: rate(completed.filter((t) => !intervened(t.id) && !humanReviewed.has(t.id)).length, completed.length),
    },
    reliability: {
      failureRecovery: rate(failedOnce.filter((t) => t.state === "COMPLETED").length, failedOnce.length),
      resumeSuccess: rate(resumed.filter((x) => !["failed", "lost"].includes(x.status)).length, resumed.length),
      workspaceFailure: rate(workspaceFailures.length, recentWorkExecs.length),
    },
    platform: {
      agentsIntegrated: agents.size,
      runnersOnline: online.length,
      concurrentSessions: active,
      peakConcurrentSessions: peak,
      projectsManaged: counted?.projects ?? 0,
      meanQueueWaitMs: mean(queueWaits),
      meanDispatchMs: mean(dispatch),
    },
  };
}
