import type { ActorDto, ProjectDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { Empty, ErrorBox, Loading, Sparkline } from "./ui.js";

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** What the project's agents cost, against its budget (spec §39). */
export function CostsTab({ project, actor }: { project: ProjectDto; actor: ActorDto }) {
  const [report, error, reload] = useLiveQuery(
    () => api.costs(project.id),
    [project.id],
    (e) => e.projectId === project.id && (e.type === "AgentFinished" || e.type.includes("Budget")),
  );
  if (error) return <ErrorBox error={error} />;
  if (!report) return <Loading />;

  const total = report.rows.reduce((s, r) => s + r.costUsd, 0);
  // One point per day for the last 14 days (UTC, like the report); days without runs count as zero.
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10));
  const rows = report.rows;
  const sumBy = (pick: (r: (typeof rows)[number]) => number) =>
    days.map((day) => rows.filter((r) => r.day.slice(0, 10) === day).reduce((s, r) => s + pick(r), 0));
  const costByDay = sumBy((r) => r.costUsd);
  const tokensByDay = sumBy((r) => r.inputTokens + r.outputTokens);
  const runsByDay = sumBy((r) => r.executions);
  const daily = report.budget?.dailyUsd;
  return (
    <div className="costs">
      <div className="stats">
        <div className={`stat ${daily && report.todayUsd >= daily ? "stat-attention" : ""}`}>
          <div className="stat-value">{usd(report.todayUsd)}</div>
          <div className="stat-label">today{daily ? ` of ${usd(daily)} budget` : ""}</div>
          <Sparkline values={costByDay} labels={days} format={usd} {...(daily && { refLine: daily })} />
        </div>
        <div className="stat">
          <div className="stat-value">{usd(total)}</div>
          <div className="stat-label">last 14 days</div>
          <Sparkline values={costByDay} labels={days} format={usd} />
        </div>
        <div className="stat">
          <div className="stat-value">{tokens(tokensByDay.reduce((s, n) => s + n, 0))}</div>
          <div className="stat-label">tokens · {runsByDay.reduce((s, n) => s + n, 0)} runs</div>
          <Sparkline values={tokensByDay} labels={days} format={(n) => `${tokens(n)} tokens`} />
        </div>
        <div className="stat">
          <div className="stat-value">{report.budget?.perTaskUsd ? usd(report.budget.perTaskUsd) : "—"}</div>
          <div className="stat-label">per-task limit</div>
        </div>
      </div>

      {actor.role === "owner" && <BudgetForm project={project} onSaved={reload} />}

      {report.rows.length === 0 ? (
        <Empty>No executions in the last 14 days.</Empty>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Agent</th>
                <th>Runs</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={`${r.day}-${r.agent}`}>
                  <td className="mono">{r.day}</td>
                  <td>
                    <span className="chip">{r.agent}</span>
                  </td>
                  <td>{r.executions}</td>
                  <td>{tokens(r.inputTokens)}</td>
                  <td>{tokens(r.outputTokens)}</td>
                  <td title={r.estimated ? "partly estimated from the agent's pricing" : "reported by the agent"}>
                    {usd(r.costUsd)}
                    {r.estimated ? " ≈" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Agents that do not report cost are estimated from the pricing in the runner config (≈); without pricing their cost is not counted.</p>
    </div>
  );
}

function BudgetForm({ project, onSaved }: { project: ProjectDto; onSaved: () => void }) {
  const [daily, setDaily] = useState(project.budget?.dailyUsd?.toString() ?? "");
  const [perTask, setPerTask] = useState(project.budget?.perTaskUsd?.toString() ?? "");
  const [error, setError] = useState<Error>();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const budget = {
      ...(daily && { dailyUsd: Number(daily) }),
      ...(perTask && { perTaskUsd: Number(perTask) }),
    };
    try {
      await api.setBudget(project.id, Object.keys(budget).length ? budget : null);
      setError(undefined);
      onSaved();
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <form className="card budget-form" onSubmit={save}>
      <label>
        Daily budget (USD)
        <input type="number" min="0" step="0.01" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="unlimited" />
      </label>
      <label>
        Per task (USD)
        <input type="number" min="0" step="0.01" value={perTask} onChange={(e) => setPerTask(e.target.value)} placeholder="unlimited" />
      </label>
      <button className="primary">Save budget</button>
      <ErrorBox error={error} />
    </form>
  );
}
