import type { ActorDto, TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { COLUMNS, groupByColumn } from "../lib/model.js";
import { href, type ProjectTab } from "../lib/router.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { Graph } from "./Graph.js";
import { CostsTab } from "./CostsTab.js";
import { KnowledgeTab } from "./KnowledgeTab.js";
import { NewTaskDialog } from "./NewTaskDialog.js";
import { NewPlanDialog, PlansList } from "./PlansPage.js";
import { Empty, ErrorBox, Loading, StateBadge } from "./ui.js";

export function ProjectPage({ id, tab, actor }: { id: string; tab: ProjectTab; actor: ActorDto }) {
  const [project, projectError] = useLiveQuery(() => api.project(id), [id], () => false);
  const [tasks, tasksError] = useLiveQuery(
    () => api.tasks(id),
    [id],
    (e) => e.projectId === id && (e.type === "TaskStateChanged" || e.type === "TaskCreated" || e.type === "PullRequestOpened"),
  );
  const [creating, setCreating] = useState(false);
  const [planning, setPlanning] = useState(false);

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
            {project.validation.length ? ` · validation: ${project.validation.map((v) => v.name).join(", ")}` : " · no validation"}
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
        <a className={tab === "activity" ? "active" : ""} href={href.project(id, "activity")}>
          Activity
        </a>
      </nav>

      <ErrorBox error={tasksError} />
      {!tasks ? (
        <Loading />
      ) : tab === "board" ? (
        <Board tasks={tasks} />
      ) : tab === "graph" ? (
        tasks.length ? <Graph tasks={tasks} /> : <Empty>No tasks yet.</Empty>
      ) : tab === "plans" ? (
        <PlansList projectId={id} />
      ) : tab === "knowledge" ? (
        <KnowledgeTab projectId={id} actor={actor} />
      ) : tab === "costs" ? (
        <CostsTab project={project} actor={actor} />
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

function Board({ tasks }: { tasks: TaskDto[] }) {
  const groups = groupByColumn(tasks);
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
              </div>
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}
