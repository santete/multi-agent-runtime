import type { MetricRate, ProductMetrics } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { ErrorBox, Loading, Section } from "./ui.js";

const pct = (r: MetricRate) => (r.value === null ? "—" : `${Math.round(r.value * 100)}%`);
const duration = (ms: number | null) => {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};

/** A rate where lower is better gets the attention colour when it is high. */
function Rate({ label, rate, lowerIsBetter = false, hint }: { label: string; rate: MetricRate; lowerIsBetter?: boolean; hint: string }) {
  const bad = rate.value !== null && (lowerIsBetter ? rate.value > 0.3 : rate.value < 0.5);
  return (
    <div className={`stat ${bad ? "stat-attention" : ""}`} title={hint}>
      <div className="stat-value">{pct(rate)}</div>
      <div className="stat-label">
        {label} <span className="muted">({rate.numerator}/{rate.denominator})</span>
      </div>
    </div>
  );
}

function Value({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Product success metrics (spec §64). */
export function MetricsPage() {
  const [projectId, setProjectId] = useState("");
  const [days, setDays] = useState(30);
  const [projects] = useLiveQuery(() => api.projects(), [], () => false);
  const [m, error] = useLiveQuery<ProductMetrics>(
    () => api.metrics(projectId || undefined, days),
    [projectId, days],
    (e) => e.type === "TaskStateChanged" && (!projectId || e.projectId === projectId),
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Metrics</h1>
          <p className="muted small">How well the team of agents works (spec §64). Hover a number for its definition.</p>
        </div>
        <div className="actions">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                last {d} {d === 1 ? "day" : "days"}
              </option>
            ))}
          </select>
        </div>
      </header>
      <ErrorBox error={error} />
      {!m ? (
        <Loading />
      ) : (
        <>
          <Section title="Engineering">
            <div className="stats">
              <Rate label="task success" rate={m.engineering.taskSuccess} hint="Finished work tasks that were merged (vs. blocked)" />
              <Rate label="validation pass" rate={m.engineering.validationPass} hint="Validation runs that passed" />
              <Rate label="rework" rate={m.engineering.rework} lowerIsBetter hint="Finished tasks that went through rework at least once" />
              <Rate label="review rejection" rate={m.engineering.reviewRejection} lowerIsBetter hint="Reviews (people and agents) that asked for changes" />
              <Value label="mean completion" value={duration(m.engineering.meanCompletionMs)} hint="From creation to merge, for merged tasks" />
            </div>
          </Section>
          <Section title="Automation">
            <div className="stats">
              <Rate
                label="human intervention"
                rate={m.automation.humanIntervention}
                lowerIsBetter
                hint="Finished tasks where a person had to do more than review: approvals, answers, retries, instructions, pauses, rejections"
              />
              <Rate label="auto-resolution" rate={m.automation.autoResolution} hint="Tasks that hit rework or a retry and were merged without a person stepping in" />
              <Rate label="autonomous completion" rate={m.automation.autonomousCompletion} hint="Merged tasks no person touched, review included" />
            </div>
          </Section>
          <Section title="Collaboration">
            <div className="stats">
              <Rate label="handoff success" rate={m.collaboration.handoffSuccess} hint="Agent runs that ended with a usable handoff" />
              <Rate label="context reuse" rate={m.collaboration.contextReuse} hint="Work runs that started from shared knowledge or the handoffs of earlier tasks" />
              <Rate
                label="agent-to-agent handoff"
                rate={m.collaboration.agentToAgentHandoff}
                hint="Tasks continuing another agent's work (a dependency done by a different agent) that were merged"
              />
            </div>
          </Section>
          <Section title="Reliability">
            <div className="stats">
              <Rate label="failure recovery" rate={m.reliability.failureRecovery} hint="Tasks whose agent or runner failed at least once that were still merged" />
              <Rate label="resume success" rate={m.reliability.resumeSuccess} hint="Runs that resumed an agent session and did not fail" />
              <Rate label="workspace failures" rate={m.reliability.workspaceFailure} lowerIsBetter hint="Work runs that failed preparing the workspace" />
            </div>
          </Section>
          <Section title="Platform">
            <div className="stats">
              <Value label="agents integrated" value={m.platform.agentsIntegrated} hint="Distinct agents offered by registered runners" />
              <Value label="runners online" value={m.platform.runnersOnline} hint="Runners seen recently" />
              <Value
                label="sessions now / peak"
                value={`${m.platform.concurrentSessions} / ${m.platform.peakConcurrentSessions}`}
                hint="Executions running now, and the most at once in the window"
              />
              <Value label="projects" value={m.platform.projectsManaged} hint="Projects managed" />
              <Value label="queue wait" value={duration(m.platform.meanQueueWaitMs)} hint="Mean time from READY to assigned" />
              <Value label="dispatch" value={duration(m.platform.meanDispatchMs)} hint="Mean time from assigned to the agent starting (workspace preparation included)" />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
