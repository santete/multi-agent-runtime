import { alignChecks, type ActorDto, type ApprovalDto, type ArtifactDto, type ExecutionDto, type InstructionDto, type TaskDto, type ValidationReport } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { PRIORITIES, priorityLabel, timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { EventRow } from "./ActivityFeed.js";
import { AgentConsole } from "./AgentConsole.js";
import { ApprovalCard } from "./ApprovalsPage.js";
import { DecisionCard, HumanTaskCard } from "./HumanWork.js";
import { Empty, ErrorBox, Loading, Pill, Section, StateBadge } from "./ui.js";

const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);
const PAUSABLE = new Set(["READY", "ASSIGNED", "RUNNING", "REWORK", "RETRYING"]);
const roleRank = { viewer: 0, member: 1, senior: 2, owner: 3, runner: -1 } as const;

export function TaskPage({ id, actor }: { id: string; actor: ActorDto }) {
  const forTask = (e: { taskId: string | null }) => e.taskId === id;
  const [task, error, reload] = useLiveQuery(() => api.task(id), [id], forTask);
  const [executions] = useLiveQuery(() => api.executions(id), [id], forTask);
  const [artifacts] = useLiveQuery(() => api.artifacts(id), [id], (e) => forTask(e) && e.type === "ArtifactCreated");
  const [approvals] = useLiveQuery(() => api.taskApprovals(id), [id], (e) => forTask(e) && e.type.startsWith("Approval"));
  const [events] = useLiveQuery(() => api.taskEvents(id), [id], (e) => forTask(e) && e.type !== "AgentEvent");
  const [selected, setSelected] = useState<string>();
  const [instructions] = useLiveQuery(
    () => api.instructions(id),
    [id],
    (e) => forTask(e) && (e.type === "InstructionSent" || e.type === "ExecutionAssigned"),
  );
  const [decisions] = useLiveQuery(() => api.decisions({ taskId: id }), [id], (e) => forTask(e) && e.type.startsWith("Decision"));

  if (error) return <ErrorBox error={error} />;
  if (!task) return <Loading />;

  const latest = <T extends ArtifactDto["type"]>(type: T) => artifacts?.filter((a) => a.type === type).at(-1);
  const handoff = latest("handoff");
  const reviews = (artifacts ?? []).filter((a) => a.type === "review_result");
  const validation = latest("validation_result");
  const diff = latest("diff");
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
            agent <span className="chip">{task.agent}</span> · priority{" "}
            {canAct && !TERMINAL.has(task.state) ? (
              <select className="inline-select" value={task.priority} onChange={(e) => api.setPriority(task.id, Number(e.target.value)).then(reload)}>
                {[...new Set([...PRIORITIES.map((p) => p.value), task.priority])].sort((a, b) => a - b).map((v) => (
                  <option key={v} value={v}>
                    {priorityLabel(v)} ({v})
                  </option>
                ))}
              </select>
            ) : (
              `${priorityLabel(task.priority)} (${task.priority})`
            )}{" "}
            {task.paths.length > 0 && (
              <>
                · area{" "}
                {task.paths.map((p) => (
                  <span key={p} className="chip mono">
                    {p}
                  </span>
                ))}{" "}
              </>
            )}
            · created {timeAgo(task.createdAt)} · updated{" "}
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

          <ContractView task={task} handoff={handoff?.content} review={reviews.at(-1)?.content} />

          {task.agent === "human" && task.state === "READY" && (
            <Section title="For a person">
              <HumanTaskCard task={task} actor={actor} onDone={reload} />
            </Section>
          )}
          {decisions && decisions.length > 0 && (
            <Section title="Questions">
              {decisions.map((d) => (
                <DecisionCard key={d.id} decision={d} actor={actor} />
              ))}
            </Section>
          )}

          {approvals && approvals.length > 0 && (
            <Section title="Approvals">
              {approvals.map((a: ApprovalDto) => (
                <ApprovalCard key={a.id} approval={a} actor={actor} />
              ))}
            </Section>
          )}

          {task.kind === "review" && task.reviewOf && (
            <p className="small">
              Agent review of <a href={href.task(task.reviewOf)}>the reviewed task</a>.
            </p>
          )}

          {(artifacts ?? []).some((a) => a.type === "review_result") && (
            <Section title="Reviews">
              {(artifacts ?? [])
                .filter((a) => a.type === "review_result")
                .map((a) => (
                  <ReviewView key={a.id} content={a.content} />
                ))}
            </Section>
          )}

          {task.kind !== "review" && (
            <Section title="Handoff">
              {handoff ? <HandoffView content={handoff.content} /> : <Empty>No handoff yet.</Empty>}
            </Section>
          )}

          {diff && (
            <Section title={`Diff · ${(diff.content.files as string[]).length} files`}>
              <DiffView text={diff.content.text as string} />
            </Section>
          )}

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
                  // Allowed tool calls are in the agent console; the timeline keeps what matters.
                  .filter(
                    (e) =>
                      e.type !== "AgentEvent" &&
                      e.type !== "ArtifactCreated" &&
                      !(e.type === "ToolCallChecked" && e.payload.decision === "allow"),
                  )
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
          {task.kind === "work" && task.agent !== "human" && (canAct || (instructions ?? []).length > 0) && (
            <Section title="Instructions">
              <Instructions task={task} instructions={instructions ?? []} canAct={canAct} />
            </Section>
          )}
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
        {task.kind === "work" && PAUSABLE.has(task.state) && <button onClick={run(() => api.pause(task.id))}>Pause</button>}
        {task.state === "PAUSED" && (
          <button className="primary" onClick={run(() => api.resume(task.id))}>
            Resume
          </button>
        )}
        {!TERMINAL.has(task.state) && task.state !== "MERGING" && (
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
          : execution.status === "cancelled" || execution.status === "interrupted"
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

/** A human review ({decision, comment}) or an agent review ({verdict, summary, findings, reviewer}). */
function ReviewView({ content }: { content: Record<string, any> }) {
  const approved = (content.verdict ?? content.decision) === "approve";
  const findings: Array<{ severity: string; file: string; line: number | null; message: string }> = content.findings ?? [];
  return (
    <div className="card review-card">
      <div className="card-head">
        <Pill tone={approved ? "success" : "warning"}>{approved ? "approved" : "changes requested"}</Pill>
        <span className="small muted">by {content.reviewer ?? "a human"}</span>
      </div>
      <p className="prose">{content.summary ?? content.comment ?? ""}</p>
      {findings.length > 0 && (
        <ul className="findings">
          {findings.map((f, i) => (
            <li key={i}>
              <Pill tone={f.severity === "blocker" || f.severity === "major" ? "danger" : "neutral"}>{f.severity}</Pill>{" "}
              <span className="mono small">
                {f.file}
                {f.line ? `:${f.line}` : ""}
              </span>{" "}
              {f.message}
            </li>
          ))}
        </ul>
      )}
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

const INTERRUPTIBLE = new Set(["ASSIGNED", "RUNNING"]);

/** Spec §43 "Send instruction": what people told the agent, and a box to tell it more. */
function Instructions({ task, instructions, canAct }: { task: TaskDto; instructions: InstructionDto[]; canAct: boolean }) {
  const [text, setText] = useState("");
  const [interrupt, setInterrupt] = useState(true);
  const [error, setError] = useState<string>();
  const running = INTERRUPTIBLE.has(task.state);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.sendInstruction(task.id, text, running && interrupt);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="instructions">
      {instructions.map((i) => (
        <div key={i.id} className="instruction">
          <div className="muted small">
            {i.author} · {timeAgo(i.createdAt)} · {i.executionId ? "received" : "waiting for the next run"}
          </div>
          <div className="prose">{i.text}</div>
        </div>
      ))}
      {canAct && !TERMINAL.has(task.state) && task.state !== "MERGING" && (
        <form onSubmit={send}>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Tell the agent something: a correction, a hint, a change of plan"
          />
          <div className="actions">
            {running && (
              <label className="check small">
                <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} /> stop the agent now and resume it
                with this
              </label>
            )}
            <button className="primary" disabled={!text.trim()}>
              Send
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </form>
      )}
    </div>
  );
}

/** Spec §43 "Open diff": the task's changes so far, as a unified diff. */
function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <Empty>No changes.</Empty>;
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("diff --git")
              ? "diff-file"
              : line.startsWith("@@")
                ? "diff-hunk"
                : line.startsWith("+") && !line.startsWith("+++")
                  ? "diff-add"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "diff-del"
                    : ""
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * Spec §62: the task's contract, and each acceptance criterion as last
 * checked: by a reviewer when there is a review, otherwise by the agent.
 */
function ContractView({ task, handoff, review }: { task: TaskDto; handoff: Record<string, unknown> | undefined; review: Record<string, unknown> | undefined }) {
  const c = task.contract;
  if (!c || (!c.inputs.length && !c.constraints.length && !c.expectedOutput && !c.acceptanceCriteria.length && !task.owner)) return null;
  const reviewed = Array.isArray(review?.criteria) && (review!.criteria as unknown[]).length > 0;
  const checks = alignChecks(c.acceptanceCriteria, reviewed ? review!.criteria : handoff?.criteria);
  const reported = reviewed || Array.isArray(handoff?.criteria);
  return (
    <Section title="Contract">
      <dl className="contract">
        {task.owner && (
          <>
            <dt>Owner</dt>
            <dd>{task.owner}</dd>
          </>
        )}
        {c.inputs.length > 0 && (
          <>
            <dt>Inputs</dt>
            <dd>
              <List items={c.inputs} />
            </dd>
          </>
        )}
        {c.constraints.length > 0 && (
          <>
            <dt>Constraints</dt>
            <dd>
              <List items={c.constraints} />
            </dd>
          </>
        )}
        {c.expectedOutput && (
          <>
            <dt>Expected output</dt>
            <dd className="prose">{c.expectedOutput}</dd>
          </>
        )}
      </dl>
      {checks.length > 0 && (
        <>
          <div className="muted small">
            Acceptance criteria{reported ? ` · checked by ${reviewed ? `the reviewer (${String(review?.reviewer ?? "review")})` : "the agent"}` : " · not checked yet"}
          </div>
          <ul className="criteria">
            {checks.map((k) => (
              <li key={k.criterion} className={!reported ? "" : k.met ? "met" : "unmet"}>
                <span className="criterion-mark">{!reported ? "○" : k.met ? "✓" : "✗"}</span>
                <span>
                  {k.criterion}
                  {reported && k.evidence && <span className="muted small"> — {k.evidence}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
