import type { ActorDto, ApprovalDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { DecisionCard, HumanTaskCard, PlanWaitingCard, ReviewWaitingCard, StuckTaskCard } from "./HumanWork.js";
import { Empty, ErrorBox, Loading, Pill, Section } from "./ui.js";

export function ApprovalsPage({ actor }: { actor: ActorDto }) {
  const isApproval = (e: { type: string }) => e.type.startsWith("Approval");
  const [pending, error] = useLiveQuery(() => api.approvals("pending"), [], isApproval);
  const [all] = useLiveQuery(() => api.approvals(), [], isApproval);
  const decided = (all ?? []).filter((a) => a.status !== "pending").reverse().slice(0, 50);
  const isHumanWork = (e: { type: string; payload: Record<string, unknown> }) =>
    e.type.startsWith("Decision") || (e.type === "TaskStateChanged" && (e.payload.to === "READY" || e.payload.from === "READY"));
  const [questions] = useLiveQuery(() => api.decisions({ status: "pending" }), [], isHumanWork);
  const [humanTasks, , reloadHuman] = useLiveQuery(api.humanTasks, [], isHumanWork);
  const isStuckChange = (e: { type: string; payload: Record<string, unknown> }) =>
    isApproval(e) || e.type.startsWith("Decision") || (e.type === "TaskStateChanged" && (e.payload.to === "WAITING_FOR_HUMAN" || e.payload.from === "WAITING_FOR_HUMAN"));
  const [stuck, , reloadStuck] = useLiveQuery(api.stuckTasks, [], (e) => isStuckChange(e) || (e.type === "TaskStateChanged" && (e.payload.to === "BLOCKED" || e.payload.from === "BLOCKED")));
  const [waiting] = useLiveQuery(api.waiting, [], (e) => e.type.startsWith("Plan") || e.type === "TaskStateChanged");
  const nothing =
    !pending?.length && !questions?.length && !humanTasks?.length && !stuck?.length && !waiting?.plans.length && !waiting?.reviews.length;

  return (
    <div className="page">
      <h1>Inbox</h1>
      <p className="muted">Everything that waits for a person, across projects.</p>
      {nothing && pending && <Empty>Nothing waits for you. Agents are working, or there is no work yet.</Empty>}
      {waiting && waiting.plans.length > 0 && (
        <Section title={`Plans to approve (${waiting.plans.length})`}>
          {waiting.plans.map((p) => (
            <PlanWaitingCard key={p.id} plan={p} />
          ))}
        </Section>
      )}
      {waiting && waiting.reviews.length > 0 && (
        <Section title={`Work to review (${waiting.reviews.length})`}>
          {waiting.reviews.map((t) => (
            <ReviewWaitingCard key={t.id} task={t} />
          ))}
        </Section>
      )}
      {questions && questions.length > 0 && (
        <Section title={`Questions from agents (${questions.length})`}>
          {questions.map((d) => (
            <DecisionCard key={d.id} decision={d} actor={actor} showTask />
          ))}
        </Section>
      )}
      {humanTasks && humanTasks.length > 0 && (
        <Section title={`Tasks for a person (${humanTasks.length})`}>
          {humanTasks.map((t) => (
            <HumanTaskCard key={t.id} task={t} actor={actor} onDone={reloadHuman} showTask />
          ))}
        </Section>
      )}
      {stuck && stuck.length > 0 && (
        <Section title={`Stopped: needs you to act (${stuck.length})`}>
          {stuck.map((s) => (
            <StuckTaskCard key={s.task.id} stuck={s} actor={actor} onDone={reloadStuck} />
          ))}
        </Section>
      )}
      <h2>Risky actions</h2>
      <p className="muted">
        Risky actions agents tried to take. By default HIGH risk needs a senior and CRITICAL actions (pushes, credentials, infrastructure)
        are never approvable; a project's policy can change who approves what.
      </p>
      <ErrorBox error={error} />
      <Section title={`Waiting for approval (${pending?.length ?? 0})`}>
        {!pending ? (
          <Loading />
        ) : pending.length === 0 ? (
          <Empty>Nothing is waiting for a decision.</Empty>
        ) : (
          pending.map((a) => <ApprovalCard key={a.id} approval={a} actor={actor} showTask />)
        )}
      </Section>
      <Section title="Decided">
        {decided.length === 0 ? <Empty>No decisions yet.</Empty> : decided.map((a) => <ApprovalCard key={a.id} approval={a} actor={actor} showTask />)}
      </Section>
    </div>
  );
}

const canDecide = (actor: ActorDto, risk: string) =>
  actor.role === "owner" || actor.role === "senior" || (risk !== "HIGH" && actor.role === "member");

export function ApprovalCard({ approval, actor, showTask = false }: { approval: ApprovalDto; actor: ActorDto; showTask?: boolean }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const decide = (decision: "approve" | "reject") => async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.decide(approval.id, decision, comment || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`card approval ${approval.status}`}>
      <div className="card-head">
        <Pill tone={approval.risk === "HIGH" ? "warning" : "attention"}>{approval.risk}</Pill>
        {showTask && (
          <a href={href.task(approval.taskId)} className="small">
            open task
          </a>
        )}
        <span className="muted small">{timeAgo(approval.createdAt)}</span>
        {approval.status !== "pending" && (
          <Pill tone={approval.status === "approved" ? "success" : approval.status === "withdrawn" ? "neutral" : "danger"}>
            {approval.status === "withdrawn" ? "withdrawn" : `${approval.status} by ${approval.decidedBy ?? "?"}`}
          </Pill>
        )}
      </div>
      <pre className="code">{approval.summary}</pre>
      <p className="small muted">{approval.reason}</p>
      {approval.comment && <p className="small">“{approval.comment}”</p>}
      {approval.status === "pending" &&
        (canDecide(actor, approval.risk) ? (
          <div className="decide">
            <input placeholder="Comment (optional, shown to the agent)" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="danger" disabled={busy} onClick={decide("reject")}>
              Reject
            </button>
            <button className="primary" disabled={busy} onClick={decide("approve")}>
              Approve
            </button>
          </div>
        ) : (
          <p className="muted small">A {approval.risk === "HIGH" ? "senior" : "member"} needs to decide this.</p>
        ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
