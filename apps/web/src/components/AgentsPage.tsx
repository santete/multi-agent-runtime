import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { Empty, ErrorBox, Loading, Pill } from "./ui.js";

const CAPABILITY_LABELS: Record<string, (v: unknown) => string | null> = {
  resume: (v) => (v ? "resume" : null),
  structuredOutput: (v) => (v ? "structured output" : null),
  costReporting: (v) => (v ? "cost" : null),
  approval: (v) => (v === "pre-tool-hook" ? "policy hook" : v === "none" ? null : String(v)),
  pause: (v) => (v === "none" ? null : `pause: ${v}`),
};

/** Agent registry and what every runner is doing (spec §14, §42). */
export function AgentsPage() {
  const [runners, error] = useLiveQuery(
    api.runners,
    [],
    (e) => ["RunnerRegistered", "ExecutionAssigned", "ExecutionStarted", "AgentFinished", "ExecutionLost", "ValidationPassed", "ValidationFailed", "BranchPushed"].includes(e.type),
  );
  if (error) return <ErrorBox error={error} />;
  if (!runners) return <Loading />;

  return (
    <div className="page">
      <h1>Agents</h1>
      {runners.length === 0 && <Empty>No runner has registered yet. Start one with `pnpm --filter @mar/runner start`.</Empty>}
      <div className="runner-grid">
        {runners.map((r) => (
          <div key={r.id} className="card">
            <div className="card-head">
              <span className={`live-dot ${r.online ? "live" : "offline"}`} />
              <strong>{r.name}</strong>
              <span className="muted small">seen {timeAgo(r.lastSeenAt)}</span>
            </div>
            <h4>Agents</h4>
            <ul className="agents">
              {r.agents.map((a) => (
                <li key={a.id}>
                  <span className="chip">{a.id}</span> <span className="muted small">{a.adapter}</span>
                  <div className="caps">
                    {Object.entries(a.capabilities)
                      .map(([k, v]) => CAPABILITY_LABELS[k]?.(v))
                      .filter(Boolean)
                      .map((label) => (
                        <Pill key={label}>{label}</Pill>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
            <h4>Working on</h4>
            {r.activeExecutions.length === 0 ? (
              <p className="muted small">Idle.</p>
            ) : (
              <ul className="agents">
                {r.activeExecutions.map((e) => (
                  <li key={e.executionId}>
                    <a className="mono" href={href.task(e.taskId)}>
                      {e.taskKey}
                    </a>{" "}
                    <span className="chip">{e.agent}</span> <Pill tone="active">{e.status}</Pill>{" "}
                    <span className="muted small">attempt {e.attempt}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
