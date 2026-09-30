import type { ActorDto, ApprovalDto, ArtifactDto, ExecutionDto, TaskDto, ValidationReport } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { EventRow } from "./ActivityFeed.js";
import { AgentConsole } from "./AgentConsole.js";
import { ApprovalCard } from "./ApprovalsPage.js";
import { Empty, ErrorBox, Loading, Pill, Section, StateBadge } from "./ui.js";

const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);
const roleRank = { viewer: 0, member: 1, senior: 2, owner: 3, runner: -1 } as const;

export function TaskPage({ id, actor }: { id: string; actor: ActorDto }) {
  const forTask = (e: { taskId: string | null }) => e.taskId === id;
  const [task, error, reload] = useLiveQuery(() => api.task(id), [id], forTask);
  const [executions] = useLiveQuery(() => api.executions(id), [id], forTask);
  const [artifacts] = useLiveQuery(() => api.artifacts(id), [id], (e) => forTask(e) && e.type === "ArtifactCreated");
  const [approvals] = useLiveQuery(() => api.taskApprovals(id), [id], (e) => forTask(e) && e.type.startsWith("Approval"));
  const [events] = useLiveQuery(() => api.taskEvents(id), [id], (e) => forTask(e) && e.type !== "AgentEvent");
  const [selected, setSelected] = useState<string>();

  if (error) return <ErrorBox error={error} />;
  if (!task) return <Loading />;

  const latest = <T extends ArtifactDto["type"]>(type: T) => artifacts?.filter((a) => a.type === type).at(-1);
  const handoff = latest("handoff");
  const validation = latest("validation_result");
  const current = executions?.find((e) => e.id === selected) ?? executions?.at(-1);
  const canAct = roleRank[actor.role] >= roleRank.member;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <a className="muted small" href={href.project(task.projectId)}>
            ← project
          </a>
          <div className="title-row">
            <span className="mono muted">{task.key}</span>
            <h1>{task.title}</h1>
            <StateBadge state={task.state} />
          </div>
          <p className="muted small">
            agent <span className="chip">{task.agent}</span> · created {timeAgo(task.createdAt)} · updated{" "}
            {timeAgo(task.updatedAt)}
            {task.pullRequestUrl && (
              <>
                {" · "}
                <a href={task.pullRequestUrl} target="_blank" rel="noreferrer">
                  pull request #{task.pullRequestNumber}
                </a>
              </>
            )}
          </p>
        </div>
        {canAct && <TaskActions task={task} onDone={reload} />}
      </header>

      <div className="columns-2">
        <div>
          <Section title="Objective">
            <p className="prose">{task.objective}</p>
            {task.dependsOn.length > 0 && <Dependencies ids={task.dependsOn} />}
          </Section>

          {approvals && approvals.length > 0 && (
            <Section title="Approvals">
              {approvals.map((a: ApprovalDto) => (
                <ApprovalCard key={a.id} approval={a} actor={actor} />
              ))}
            </Section>
          )}

          <Section title="Handoff">
            {handoff ? <HandoffView content={handoff.content} /> : <Empty>No handoff yet.</Empty>}
          </Section>

          <Section title="Validation">
            {validation ? (
              <ValidationView report={validation.content as unknown as ValidationReport} />
            ) : (
              <Empty>Not validated yet.</Empty>
            )}
          </Section>

          <Section title="Timeline">
            {events ? (
              <ol className="timeline">
                {events.events
                  .filter((e) => e.type !== "AgentEvent" && e.type !== "ArtifactCreated")
                  .map((e) => (
                    <EventRow key={e.id} event={e} showTask={false} />
                  ))}
              </ol>
            ) : (
              <Loading />
            )}
          </Section>
        </div>

        <div>
          <Section title="Executions">
            {!executions?.length ? (
              <Empty>Not started.</Empty>
            ) : (
              <ul className="executions">
                {executions.map((e) => (
                  <ExecutionRow key={e.id} execution={e} selected={e.id === current?.id} onSelect={() => setSelected(e.id)} />
                ))}
              </ul>
            )}
          </Section>
          {current && (
            <Section title={`Agent console · attempt ${current.attempt}`}>
              <AgentConsole execution={current} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskActions({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const run = (fn: () => Promise<unknown>) => async () => {
    setError(undefined);
    try {
      await fn();
      setComment("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="task-actions">
      {task.state === "REVIEW" && (
        <div className="review-box">
          <textarea placeholder="Review comment (sent to the agent on reject)" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
          <div className="actions">
            <button className="danger" onClick={run(() => api.review(task.id, "reject", comment))}>
              Request changes
            </button>
            <button className="primary" onClick={run(() => api.review(task.id, "approve", comment))}>
              Approve &amp; merge
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        {(task.state === "WAITING_FOR_HUMAN" || task.state === "BLOCKED") && (
          <button onClick={run(() => api.retry(task.id))}>Retry</button>
        )}
        {!TERMINAL.has(task.state) && (
          <button className="danger-outline" onClick={run(() => api.cancel(task.id))}>
            Cancel task
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function Dependencies({ ids }: { ids: string[] }) {
  const [deps] = useLiveQuery(() => Promise.all(ids.map((id) => api.task(id))), [ids.join()], (e) => ids.includes(e.taskId ?? ""));
  return (
    <div className="deps">
      <span className="muted small">Depends on</span>
      {deps?.map((d) => (
        <a key={d.id} href={href.task(d.id)} className="dep">
          <span className="mono">{d.key}</span> {d.title} <StateBadge state={d.state} />
        </a>
      ))}
    </div>
  );
}

function ExecutionRow({ execution, selected, onSelect }: { execution: ExecutionDto; selected: boolean; onSelect: () => void }) {
  const tone =
    execution.status === "succeeded"
      ? "success"
      : execution.status === "failed" || execution.status === "lost"
        ? "danger"
        : execution.status === "needs_approval"
          ? "attention"
          : execution.status === "cancelled"
            ? "neutral"
            : "active";
  return (
    <li className={selected ? "selected" : ""}>
      <button className="row-button" onClick={onSelect}>
        <span>attempt {execution.attempt}</span>
        <Pill tone={tone}>{execution.status.replace("_", " ")}</Pill>
        <span className="muted small">{timeAgo(execution.createdAt)}</span>
        {execution.sessionId && <span className="mono muted small">{execution.sessionId.slice(0, 8)}</span>}
      </button>
    </li>
  );
}

function List({ items }: { items: unknown }) {
  const list = Array.isArray(items) ? (items as string[]) : [];
  if (!list.length) return <p className="muted small">None.</p>;
  return (
    <ul className="bullets">
      {list.map((i, n) => (
        <li key={n}>{i}</li>
      ))}
    </ul>
  );
}

export function HandoffView({ content }: { content: Record<string, unknown> }) {
  return (
    <div className="handoff">
      <p className="prose">{String(content.summary ?? "")}</p>
      <h4>Changes</h4>
      <List items={content.changes} />
      <h4>Decisions</h4>
      <List items={content.decisions} />
      <h4>Known issues</h4>
      <List items={content.knownIssues} />
      <h4>Remaining work</h4>
      <List items={content.remainingWork} />
    </div>
  );
}

function ValidationView({ report }: { report: ValidationReport }) {
  return (
    <div>
      <p>
        <Pill tone={report.passed ? "success" : "danger"}>{report.passed ? "passed" : "failed"}</Pill>{" "}
        <span className="muted small">{report.changedFiles.length} changed files</span>
      </p>
      {report.steps.length === 0 ? (
        <p className="muted small">No validation steps configured.</p>
      ) : (
        report.steps.map((s) => (
          <details key={s.name} open={!s.passed}>
            <summary>
              {s.passed ? "✓" : "✗"} <strong>{s.name}</strong> <span className="mono small">{s.command}</span>{" "}
              <span className="muted small">
                exit {s.exitCode ?? "–"} · {(s.durationMs / 1000).toFixed(1)}s
              </span>
            </summary>
            <pre className="code">{s.outputTail || "(no output)"}</pre>
          </details>
        ))
      )}
      {report.changedFiles.length > 0 && (
        <details>
          <summary className="muted small">Changed files</summary>
          <ul className="mono small">
            {report.changedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
