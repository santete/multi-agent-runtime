import type { ActorDto, TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { COLUMNS, groupByColumn, priorityLabel } from "../lib/model.js";
import { href, type ProjectTab } from "../lib/router.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { Graph } from "./Graph.js";
import { CostsTab } from "./CostsTab.js";
import { KnowledgeTab } from "./KnowledgeTab.js";
import { NewTaskDialog } from "./NewTaskDialog.js";
import { PolicyTab } from "./PolicyTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { NewPlanDialog, PlansList } from "./PlansPage.js";
import { Empty, ErrorBox, Loading, StateBadge } from "./ui.js";

export function ProjectPage({ id, tab, actor }: { id: string; tab: ProjectTab; actor: ActorDto }) {
  const [project, projectError, reloadProject] = useLiveQuery(() => api.project(id), [id], (e) => e.projectId === id && e.type.startsWith("Project"));
  const [tasks, tasksError] = useLiveQuery(
    () => api.tasks(id),
    [id],
    (e) => e.projectId === id && (e.type === "TaskStateChanged" || e.type === "TaskCreated" || e.type === "PullRequestOpened"),
  );
  const [creating, setCreating] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [delivery] = useLiveQuery(() => api.delivery(id), [id], () => false);

  if (projectError) return <ErrorBox error={projectError} />;
  if (!project) return <Loading />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="mono muted">{project.key}</div>
          <h1>{project.name}</h1>
          <p className="muted small">
            {project.repoUrl} · base <span className="mono">{project.defaultBranch}</span>
            {project.maxParallel ? ` · max ${project.maxParallel} in parallel` : ""}
            {project.validation.length ? ` · validation: ${project.validation.map((v) => v.name).join(", ")}` : ""}
            {project.revalidateOnBaseChange ? " · re-validates on a moved base" : ""}
            {project.waitForChecks ? " · waits for CI" : ""}
          </p>
        </div>
        <div className="actions">
          <button onClick={() => setPlanning(true)}>New plan</button>
          <button className="primary" onClick={() => setCreating(true)}>
            New task
          </button>
        </div>
      </header>

      <nav className="tabs">
        <a className={tab === "board" ? "active" : ""} href={href.project(id)}>
          Board
        </a>
        <a className={tab === "graph" ? "active" : ""} href={href.project(id, "graph")}>
          Graph
        </a>
        <a className={tab === "plans" ? "active" : ""} href={href.project(id, "plans")}>
          Plans
        </a>
        <a className={tab === "knowledge" ? "active" : ""} href={href.project(id, "knowledge")}>
          Knowledge
        </a>
        <a className={tab === "costs" ? "active" : ""} href={href.project(id, "costs")}>
          Costs
        </a>
        <a className={tab === "policy" ? "active" : ""} href={href.project(id, "policy")}>
          Policy
        </a>
        <a className={tab === "settings" ? "active" : ""} href={href.project(id, "settings")}>
          Settings
        </a>
        <a className={tab === "activity" ? "active" : ""} href={href.project(id, "activity")}>
          Activity
        </a>
      </nav>

      {delivery && !delivery.pullRequests && (
        <div className="notice warning">
          Approved work is not merged automatically here: {delivery.reason}. Each approved task with changes waits in the Inbox for a
          person to merge its branch.
        </div>
      )}
      {project.validation.length === 0 && tab !== "settings" && (
        <div className="notice warning">
          No validation commands: the platform cannot check what agents deliver.{" "}
          <a href={href.project(id, "settings")}>Set them up in Settings</a>.
        </div>
      )}
      <ErrorBox error={tasksError} />
      {!tasks ? (
        <Loading />
      ) : tab === "board" ? (
        <Board tasks={tasks} projectId={id} />
      ) : tab === "graph" ? (
        tasks.length ? <Graph tasks={tasks} /> : <Empty>No tasks yet.</Empty>
      ) : tab === "plans" ? (
        <PlansList project={project} actor={actor} />
      ) : tab === "knowledge" ? (
        <KnowledgeTab projectId={id} actor={actor} />
      ) : tab === "costs" ? (
        <CostsTab project={project} actor={actor} />
      ) : tab === "policy" ? (
        <PolicyTab project={project} actor={actor} />
      ) : tab === "settings" ? (
        <SettingsTab project={project} actor={actor} onSaved={() => reloadProject()} />
      ) : (
        <ActivityFeed projectId={id} limit={100} />
      )}

      {creating && tasks && (
        <NewTaskDialog project={project} tasks={tasks} onClose={() => setCreating(false)} />
      )}
      {planning && <NewPlanDialog project={project} onClose={() => setPlanning(false)} />}
    </div>
  );
}

function Board({ tasks, projectId }: { tasks: TaskDto[]; projectId: string }) {
  const groups = groupByColumn(tasks);
  // Agents some online runner offers: READY work for any other agent will not start.
  const [runners] = useLiveQuery(api.runners, [], (e) => e.type === "RunnerRegistered");
  const offered = new Set((runners ?? []).filter((r) => r.online).flatMap((r) => r.agents.map((a) => a.id)));
  const unserved = (t: TaskDto) =>
    runners !== undefined && t.state === "READY" && t.agent !== "human" && (t.agent === "auto" ? offered.size === 0 : !offered.has(t.agent));
  // READY work in the order the scheduler will take it (spec §53).
  const [queue] = useLiveQuery(() => api.queue(projectId), [projectId, tasks], () => false);
  const rank = new Map((queue ?? []).map((e, i) => [e.taskId, { i, e }]));
  groups.ready.sort((a, b) => (rank.get(a.id)?.i ?? 999) - (rank.get(b.id)?.i ?? 999));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <div className="board">
      {COLUMNS.map((c) => (
        <section key={c.id} className={`column col-${c.id}`}>
          <h3>
            {c.title} <span className="muted">{groups[c.id].length}</span>
          </h3>
          {groups[c.id].map((t) => (
            <a key={t.id} className="task-card" href={href.task(t.id)}>
              <div className="task-card-head">
                <span className="mono">{t.key}</span>
                <StateBadge state={t.state} />
              </div>
              <div className="task-title">{t.title}</div>
              <div className="task-meta">
                <span className="chip">{t.agent}</span>
                {t.kind === "plan" && (
                  <span className="badge tone-info" title="planner run">
                    planner
                  </span>
                )}
                {t.kind === "review" && (
                  <span className="badge tone-info" title="agent code review">
                    reviews {byId.get(t.reviewOf ?? "")?.key ?? "?"}
                  </span>
                )}
                {t.dependsOn.length > 0 && (
                  <span className="muted small" title="depends on">
                    ⤷ {t.dependsOn.map((d) => byId.get(d)?.key ?? "?").join(", ")}
                  </span>
                )}
                {t.pullRequestNumber && <span className="muted small">PR #{t.pullRequestNumber}</span>}
                {t.priority > 50 && <span className="badge tone-warning">{priorityLabel(t.priority)}</span>}
                {rank.get(t.id) && t.state === "READY" && (
                  <span className="muted small" title={rank.get(t.id)!.e.reasons.join(", ")}>
                    #{rank.get(t.id)!.i + 1} · score {rank.get(t.id)!.e.score}
                  </span>
                )}
                {unserved(t) && (
                  <span className="badge tone-warning" title="Start a runner that offers this agent, or change the task's agent">
                    no online runner offers {t.agent === "auto" ? "any agent" : t.agent}
                  </span>
                )}
                {rank.get(t.id)?.e.blockedBy && t.state === "READY" && (
                  <span className="badge tone-neutral" title={`works on ${rank.get(t.id)!.e.blockedBy!.path} like an unmerged task`}>
                    waits for {rank.get(t.id)!.e.blockedBy!.key}
                  </span>
                )}
              </div>
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}
