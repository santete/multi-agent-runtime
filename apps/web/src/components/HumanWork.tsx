import type { ActorDto, DecisionDto, TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { ErrorBox, Pill } from "./ui.js";

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
        <Pill tone={decision.status === "pending" ? "attention" : "success"}>{decision.status === "pending" ? "question" : "answered"}</Pill>
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
      {decision.context && <p className="muted small prose">{decision.context}</p>}
      {decision.status === "answered" ? (
        <p className="prose">
          <strong>Answer:</strong> {decision.answer} <span className="muted small">— {decision.answeredBy}</span>
        </p>
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
      {showTask && <p className="prose small">{task.objective}</p>}
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
