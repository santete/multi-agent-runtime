import type { ActorDto, PlanDto, PlannedTask, PlanStatus, ProjectDto } from "@mar/core";
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { type Tone, timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { Empty, ErrorBox, Loading, Pill, Section } from "./ui.js";

const AUTO = "auto";
const roleRank = { viewer: 0, member: 1, senior: 2, owner: 3, runner: -1 } as const;

const STATUS: Record<PlanStatus, { label: string; tone: Tone }> = {
  planning: { label: "planning", tone: "active" },
  reviewing: { label: "critic reviewing", tone: "active" },
  proposed: { label: "waiting for review", tone: "attention" },
  approved: { label: "approved", tone: "success" },
  rejected: { label: "rejected", tone: "neutral" },
  revised: { label: "revised", tone: "neutral" },
  failed: { label: "planner failed", tone: "danger" },
};

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  return <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>;
}

const isPlanEvent = (e: { type: string }) => e.type.startsWith("Plan") || e.type === "TaskStateChanged";

/** Agent ids offered by registered runners. */
function useAgents(): string[] {
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    api.runners().then((runners) => setAgents([...new Set(runners.flatMap((r) => r.agents.map((a) => a.id)))].sort()));
  }, []);
  return agents;
}

/** The project's plans (Plans tab). */
export function PlansList({ project, actor }: { project: ProjectDto; actor: ActorDto }) {
  const projectId = project.id;
  const [plans, error] = useLiveQuery(() => api.plans(projectId), [projectId], (e) => e.projectId === projectId && isPlanEvent(e));
  if (error) return <ErrorBox error={error} />;
  if (!plans) return <Loading />;
  return (
    <div className="plan-list">
      <PlanningSettings project={project} canEdit={actor.role === "owner"} />
      {!plans.length && <Empty>No plans yet. Describe a goal with “New plan” and a planner agent proposes the tasks.</Empty>}
      {plans.map((p) => (
        <a key={p.id} className="card plan-card" href={href.plan(p.id)}>
          <div className="card-head">
            <PlanStatusBadge status={p.status} />
            <span className="muted small">
              {timeAgo(p.createdAt)}
              {p.createdBy ? ` by ${p.createdBy}` : ""}
              {p.plannerAgent ? ` · planner ${p.plannerAgent}` : ""}
            </span>
          </div>
          <div className="plan-goal">{p.goal}</div>
          <div className="muted small">
            {p.proposal ? `${p.proposal.tasks.length} tasks proposed` : "no proposal yet"}
            {p.createdTasks.length ? ` · created ${p.createdTasks.map((t) => t.key).join(", ")}` : ""}
            {p.round > 1 ? ` · round ${p.round}` : p.previousPlanId ? " · revision" : ""}
            {p.critique ? ` · ${p.critique.critic}: ${p.critique.verdict}` : ""}
          </div>
        </a>
      ))}
    </div>
  );
}

export function NewPlanDialog({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const agents = useAgents();
  const [goal, setGoal] = useState("");
  const [agent, setAgent] = useState(AUTO);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const plan = await api.createPlan(project.id, { goal, agent });
      onClose();
      window.location.hash = href.plan(plan.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New plan in {project.key}</h2>
        <p className="muted small">
          A planner agent reads the repository and proposes a task graph. Nothing is created until you approve it.
        </p>
        <label>
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={8} autoFocus required />
        </label>
        <label>
          Planner agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value={AUTO}>auto — scheduler picks</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !goal.trim()}>
            Plan it
          </button>
        </div>
      </form>
    </div>
  );
}

/** Debate and autonomy of planning (spec §53). */
function PlanningSettings({ project, canEdit }: { project: ProjectDto; canEdit: boolean }) {
  const agents = useAgents();
  const [policy, setPolicy] = useState(project.planning);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error>();
  const toggleCritic = (a: string) =>
    setPolicy((p) => ({ ...p, critics: p.critics.includes(a) ? p.critics.filter((x) => x !== a) : [...p.critics, a] }));
  const save = async () => {
    try {
      await api.setPlanning(project.id, policy);
      setSaved(true);
      setError(undefined);
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <details className="card planning-settings">
      <summary>
        Planning: {policy.critics.length ? `critic ${policy.critics.join(", ")}, up to ${policy.maxRounds} round(s)` : "no critic"}
        {policy.autoApprove ? ` · approves itself up to ${policy.maxAutoTasks} tasks` : " · a person approves"}
      </summary>
      <fieldset disabled={!canEdit}>
        <div className="checks">
          Critics:
          {agents.map((a) => (
            <label key={a} className="check">
              <input type="checkbox" checked={policy.critics.includes(a)} onChange={() => toggleCritic(a)} />
              {a}
            </label>
          ))}
        </div>
        <div className="plan-row">
          <label>
            Debate rounds
            <input type="number" min={0} max={5} value={policy.maxRounds} onChange={(e) => setPolicy({ ...policy, maxRounds: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={policy.autoApprove} onChange={(e) => setPolicy({ ...policy, autoApprove: e.target.checked })} />
            Approve automatically when the critic approves
          </label>
          <label>
            …with at most this many tasks
            <input type="number" min={1} max={20} value={policy.maxAutoTasks} onChange={(e) => setPolicy({ ...policy, maxAutoTasks: Number(e.target.value) })} />
          </label>
        </div>
        {canEdit && (
          <div className="actions left">
            <button className="primary" type="button" onClick={save}>
              Save
            </button>
            {saved && <span className="muted small">saved</span>}
          </div>
        )}
        <ErrorBox error={error} />
      </fieldset>
    </details>
  );
}

/** One plan: the proposal to review, edit and approve (spec §24). */
export function PlanPage({ id, actor }: { id: string; actor: ActorDto }) {
  const [plan, error, reload] = useLiveQuery(() => api.plan(id), [id], isPlanEvent);
  const [newer] = useLiveQuery(
    () => (plan?.status === "revised" ? api.plans(plan.projectId) : Promise.resolve([] as PlanDto[])),
    [plan?.status, plan?.projectId],
    (e) => e.type.startsWith("Plan"),
  );
  const agents = useAgents();
  const [draft, setDraft] = useState<PlannedTask[]>();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    if (plan?.proposal) setDraft(plan.proposal.tasks);
  }, [plan?.proposal]);

  if (error) return <ErrorBox error={error} />;
  if (!plan) return <Loading />;

  const canAct = roleRank[actor.role] >= roleRank.member;
  const editable = canAct && plan.status === "proposed";
  const tasks = (editable ? draft : plan.proposal?.tasks) ?? [];
  const edited = JSON.stringify(draft) !== JSON.stringify(plan.proposal?.tasks);
  const revision = newer?.find((p) => p.previousPlanId === plan.id);
  const createdKey = (ref: string) => plan.createdTasks.find((t) => t.ref === ref);

  const act = async (run: () => Promise<PlanDto>, navigate = false) => {
    setBusy(true);
    setActionError(undefined);
    try {
      const result = await run();
      if (navigate) window.location.hash = href.plan(result.id);
      else reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const update = (i: number, patch: Partial<PlannedTask>) => setDraft((d) => d?.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const remove = (i: number) => {
    const ref = draft?.[i]?.ref;
    setDraft((d) => d?.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((x) => x !== ref) })));
  };
  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <a className="muted small" href={href.project(plan.projectId, "plans")}>
            ← plans
          </a>
          <div className="title-row">
            <h1>Plan</h1>
            <PlanStatusBadge status={plan.status} />
          </div>
          <p className="muted small">
            requested {timeAgo(plan.createdAt)}
            {plan.createdBy ? ` by ${plan.createdBy}` : ""}
            {plan.plannerTaskId && (
              <>
                {" · planner "}
                <a href={href.task(plan.plannerTaskId)}>
                  {plan.plannerTaskKey} ({plan.plannerAgent})
                </a>
              </>
            )}
            {plan.decidedBy ? ` · ${plan.status} by ${plan.decidedBy} ${timeAgo(plan.decidedAt!)}` : ""}
          </p>
        </div>
      </header>

      <Section title="Goal">
        <p className="prose">{plan.goal}</p>
        {plan.feedback && (
          <p className="small">
            Revises <a href={href.plan(plan.previousPlanId!)}>an earlier plan</a> with the feedback: “{plan.feedback}”
          </p>
        )}
      </Section>

      {plan.status === "planning" && (
        <Empty>
          The planner is reading the repository. Follow it live on{" "}
          {plan.plannerTaskId ? <a href={href.task(plan.plannerTaskId)}>its task</a> : "its task"}.
        </Empty>
      )}
      {plan.status === "reviewing" && <Empty>A critic agent is checking the plan before anyone approves it.</Empty>}
      {plan.critique && (
        <Section title={`Critique by ${plan.critique.critic} (round ${plan.round})`}>
          <p className="prose">
            <Pill tone={plan.critique.verdict === "approve" ? "success" : "attention"}>{plan.critique.verdict}</Pill> {plan.critique.summary}
          </p>
          {plan.critique.issues.length > 0 && (
            <ul className="bullets">
              {plan.critique.issues.map((i, n) => (
                <li key={n}>
                  <span className="mono">[{i.severity}]</span> {i.ref ? <strong>{i.ref}: </strong> : null}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {plan.status === "failed" && (
        <div className="error">
          The planner did not produce a usable plan. See{" "}
          {plan.plannerTaskId ? <a href={href.task(plan.plannerTaskId)}>its task</a> : "its task"} for why, then start a new plan from the
          project page (the Plans tab or New plan), maybe with another planner agent.
        </div>
      )}
      {plan.status === "approved" && (
        <div className="notice success">
          Approved: {plan.createdTasks.length} task{plan.createdTasks.length === 1 ? " was" : "s were"} created and start as soon as their
          dependencies are merged. Follow them on the <a href={href.project(plan.projectId)}>board</a>; each one comes to your{" "}
          <a href={href.approvals()}>Inbox</a> when it needs you (a review, a question, a merge).
        </div>
      )}
      {plan.status === "revised" && revision && (
        <p className="small">
          Sent back to the planner: <a href={href.plan(revision.id)}>see the revised plan</a>.
        </p>
      )}

      {plan.proposal && (
        <Section title={`Proposed tasks (${tasks.length})`}>
          {plan.proposal.summary && <p className="prose">{plan.proposal.summary}</p>}
          {tasks.length === 0 && <Empty>The planner found nothing left to do. Reject the plan, or ask for a revision if you disagree.</Empty>}
          <div className="plan-tasks">
            {tasks.map((t, i) => (
              <div key={t.ref} className="card plan-task">
                <div className="card-head">
                  <span className="mono">{t.ref}</span>
                  {createdKey(t.ref) && <a href={href.task(createdKey(t.ref)!.taskId)}>{createdKey(t.ref)!.key}</a>}
                  {t.dependsOn.length > 0 && <span className="muted small">after {t.dependsOn.join(", ")}</span>}
                  {editable && (
                    <button type="button" className="link" onClick={() => remove(i)} disabled={tasks.length === 1}>
                      remove
                    </button>
                  )}
                </div>
                {editable ? (
                  <div className="plan-fields">
                    <label>
                      Title
                      <input value={t.title} onChange={(e) => update(i, { title: e.target.value })} />
                    </label>
                    <label>
                      Objective
                      <textarea value={t.objective} rows={3} onChange={(e) => update(i, { objective: e.target.value })} />
                    </label>
                    <div className="plan-row">
                      <label>
                        Agent
                        <select value={t.agent ?? AUTO} onChange={(e) => update(i, { agent: e.target.value === AUTO ? null : e.target.value })}>
                          <option value={AUTO}>auto</option>
                          {[...new Set([...agents, ...(t.agent ? [t.agent] : [])])].map((a) => (
                            <option key={a}>{a}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Requires
                        <input value={t.requires.join(", ")} onChange={(e) => update(i, { requires: list(e.target.value) })} />
                      </label>
                      <label>
                        Depends on
                        <input value={t.dependsOn.join(", ")} onChange={(e) => update(i, { dependsOn: list(e.target.value) })} />
                      </label>
                      <label>
                        Area
                        <input value={(t.paths ?? []).join(", ")} onChange={(e) => update(i, { paths: list(e.target.value) })} />
                      </label>
                    </div>
                    <label>
                      Expected output
                      <input value={t.expectedOutput ?? ""} onChange={(e) => update(i, { expectedOutput: e.target.value })} />
                    </label>
                    <label>
                      Acceptance criteria (one per line)
                      <textarea
                        rows={3}
                        value={(t.acceptanceCriteria ?? []).join("\n")}
                        onChange={(e) => update(i, { acceptanceCriteria: e.target.value.split("\n") })}
                        onBlur={(e) => update(i, { acceptanceCriteria: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })}
                      />
                    </label>
                    <label>
                      Constraints (one per line)
                      <textarea
                        rows={2}
                        value={(t.constraints ?? []).join("\n")}
                        onChange={(e) => update(i, { constraints: e.target.value.split("\n") })}
                        onBlur={(e) => update(i, { constraints: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })}
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="task-title">{t.title}</div>
                    <p className="prose small">{t.objective}</p>
                    <div className="task-meta">
                      <span className="chip">{t.agent ?? "auto"}</span>
                      {t.requires.length > 0 && <span className="muted small">needs {t.requires.join(", ")}</span>}
                      {(t.paths ?? []).length > 0 && <span className="muted small mono">{t.paths.join(", ")}</span>}
                    </div>
                    {t.expectedOutput && <p className="small"><span className="muted">Expected output:</span> {t.expectedOutput}</p>}
                    {(t.acceptanceCriteria ?? []).length > 0 && (
                      <ul className="criteria small">
                        {t.acceptanceCriteria.map((c) => (
                          <li key={c}>
                            <span className="criterion-mark">○</span>
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {(t.constraints ?? []).length > 0 && <p className="muted small">Constraints: {t.constraints.join("; ")}</p>}
                  </>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {editable && (
        <Section title="Decision">
          <ErrorBox error={actionError ? new Error(actionError) : undefined} />
          <div className="actions left">
            <button
              className="primary"
              disabled={busy || tasks.length === 0}
              onClick={() => act(() => api.approvePlan(plan.id, edited && draft ? { tasks: draft } : {}))}
            >
              {edited ? "Approve edited plan" : "Approve and create tasks"}
            </button>
            {edited && (
              <button type="button" disabled={busy} onClick={() => setDraft(plan.proposal!.tasks)}>
                Undo edits
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => act(() => api.rejectPlan(plan.id))}>
              Reject
            </button>
          </div>
          <label className="revise">
            Or ask the planner to revise it
            <textarea
              value={feedback}
              rows={3}
              placeholder="e.g. split the API task into model and endpoint"
              onChange={(e) => setFeedback(e.target.value)}
            />
          </label>
          <div className="actions left">
            <button disabled={busy || !feedback.trim()} onClick={() => act(() => api.revisePlan(plan.id, feedback), true)}>
              Request changes
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
