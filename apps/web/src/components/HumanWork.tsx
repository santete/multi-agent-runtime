import type { ActorDto, DecisionDto, PlanDto, StuckTaskDto, TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { ErrorBox, Pill, Prose } from "./ui.js";

const canAct = (actor: ActorDto) => actor.role !== "viewer" && actor.role !== "runner";

/** A question an agent could not decide alone (spec §61), with its answer form. */
export function DecisionCard({ decision, actor, showTask = false }: { decision: DecisionDto; actor: ActorDto; showTask?: boolean }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => {
    setBusy(true);
    try {
      await api.answerDecision(decision.id, value);
      setError(undefined);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card decision ${decision.status}`}>
      <div className="card-head">
        <Pill tone={decision.status === "pending" ? "attention" : decision.status === "answered" ? "success" : "neutral"}>
          {decision.status === "pending" ? "question" : decision.status}
        </Pill>
        {showTask && (
          <a className="mono" href={href.task(decision.taskId)}>
            {decision.taskKey}
          </a>
        )}
        <span className="muted small">
          asked by <span className="chip">{decision.agent}</span> {timeAgo(decision.createdAt)}
        </span>
      </div>
      <p className="decision-question">{decision.question}</p>
      {decision.context && (
        <div className="muted">
          <Prose text={decision.context} small collapsible />
        </div>
      )}
      {decision.status === "answered" ? (
        <p className="prose">
          <strong>Answer:</strong> {decision.answer} <span className="muted small">— {decision.answeredBy}</span>
        </p>
      ) : decision.status === "withdrawn" ? (
        <p className="muted small">Withdrawn: the task was cancelled or retried before anyone answered.</p>
      ) : canAct(actor) ? (
        <div className="decision-answer">
          {decision.options.length > 0 && (
            <div className="actions left">
              {decision.options.map((o) => (
                <button key={o} disabled={busy} onClick={() => submit(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <textarea rows={2} placeholder="Or answer in your own words" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="actions left">
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => submit(answer.trim())}>
              Answer
            </button>
          </div>
        </div>
      ) : null}
      <ErrorBox error={error} />
    </div>
  );
}

/** A task assigned to "human": a person does it and records the outcome. */
export function HumanTaskCard({ task, actor, onDone, showTask = false }: { task: TaskDto; actor: ActorDto; onDone?: () => void; showTask?: boolean }) {
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<Error>();
  const done = async () => {
    try {
      await api.completeHumanTask(task.id, summary.trim());
      setError(undefined);
      onDone?.();
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <div className="card decision pending">
      <div className="card-head">
        <Pill tone="attention">for a person</Pill>
        {showTask && (
          <a className="mono" href={href.task(task.id)}>
            {task.key}
          </a>
        )}
        <strong>{task.title}</strong>
      </div>
      {showTask && <Prose text={task.objective} small collapsible />}
      {canAct(actor) && (
        <>
          <textarea rows={3} placeholder="What you decided or did (the next tasks get this)" value={summary} onChange={(e) => setSummary(e.target.value)} />
          <div className="actions left">
            <button className="primary" disabled={!summary.trim()} onClick={done}>
              Done
            </button>
          </div>
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

/**
 * A task that stopped for a person with nothing to approve or answer: a call
 * the policy refused outright, or one the agent CLI refused itself. Retry
 * starts a new attempt; cancel ends the task.
 */
export function StuckTaskCard({ stuck, actor, onDone }: { stuck: StuckTaskDto; actor: ActorDto; onDone: () => void }) {
  const { task, reasons, manualMerge } = stuck;
  const [sha, setSha] = useState("");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await call();
      setError(undefined);
      onDone();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card decision">
      <div className="card-head">
        <Pill tone={task.state === "BLOCKED" ? "danger" : "warning"}>{manualMerge ? "merge by hand" : task.state === "BLOCKED" ? "blocked" : "stopped"}</Pill>
        <a className="mono" href={href.task(task.id)}>
          {task.key}
        </a>
        <span>{task.title}</span>
        <span className="muted small">
          <span className="chip">{task.agent}</span> {timeAgo(task.updatedAt)}
        </span>
      </div>
      {manualMerge ? (
        <>
          <p className="small">
            Approved, but it cannot be merged automatically: {manualMerge.reason}. Merge branch <span className="mono">{manualMerge.branch}</span>{" "}
            into <span className="mono">{manualMerge.base}</span> yourself (a pull request on the host, or locally), then confirm here. Tasks
            that depend on it start after that.
          </p>
          <pre className="code small">{`git fetch origin\ngit checkout ${manualMerge.base} && git pull\ngit merge --no-ff origin/${manualMerge.branch}\ngit push origin ${manualMerge.base}`}</pre>
          {canAct(actor) && (
            <div className="actions left">
              <input className="mono" value={sha} onChange={(e) => setSha(e.target.value)} placeholder="merge commit (optional)" />
              <button className="primary" disabled={busy} onClick={act(() => api.markMerged(task.id, sha.trim() || undefined))}>
                I merged it
              </button>
              <button className="danger" disabled={busy} onClick={act(() => api.cancel(task.id))}>
                Cancel task
              </button>
            </div>
          )}
          <ErrorBox error={error} />
        </>
      ) : reasons.length ? (
        <>
          <p className="small">{task.state === "BLOCKED" ? "It failed too often:" : "Refused calls in the last attempt:"}</p>
          <ul className="small mono">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">The last attempt asked for a person; see the task page.</p>
      )}
      {!manualMerge && canAct(actor) && (
        <div className="actions left">
          <button className="primary" disabled={busy} onClick={act(() => api.retry(task.id))}>
            Retry
          </button>
          <button className="danger" disabled={busy} onClick={act(() => api.cancel(task.id))}>
            Cancel task
          </button>
        </div>
      )}
      {!manualMerge && <ErrorBox error={error} />}
    </div>
  );
}

/** A plan a planner proposed: the person decides on its page. */
export function PlanWaitingCard({ plan }: { plan: PlanDto }) {
  const tasks = plan.proposal?.tasks.length ?? 0;
  return (
    <div className="card decision">
      <div className="card-head">
        <Pill tone="attention">plan</Pill>
        <span className="muted small">
          {tasks} task{tasks === 1 ? "" : "s"} proposed by <span className="chip">{plan.plannerAgent}</span> {timeAgo(plan.createdAt)}
        </span>
      </div>
      <a className="plan-title" href={href.plan(plan.id)}>
        {plan.goal.split("\n")[0]!.trim()}
      </a>
      {plan.proposal?.summary && <Prose text={plan.proposal.summary} small collapsible />}
      <div className="actions left">
        <a className="button primary" href={href.plan(plan.id)}>
          Review the plan
        </a>
      </div>
    </div>
  );
}

/** Validated work waiting for a person's review. */
export function ReviewWaitingCard({ task }: { task: TaskDto }) {
  return (
    <div className="card decision">
      <div className="card-head">
        <Pill tone="attention">review</Pill>
        <a className="mono" href={href.task(task.id)}>
          {task.key}
        </a>
        <span>{task.title}</span>
        <span className="muted small">
          by <span className="chip">{task.agent}</span> {timeAgo(task.updatedAt)}
        </span>
        {task.pullRequestUrl && (
          <a className="small" href={task.pullRequestUrl} target="_blank" rel="noreferrer">
            PR #{task.pullRequestNumber}
          </a>
        )}
      </div>
      <div className="actions left">
        <a className="button primary" href={href.task(task.id)}>
          Review
        </a>
      </div>
    </div>
  );
}
