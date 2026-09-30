import type { TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { COLUMNS, groupByColumn } from "../lib/model.js";
import { href } from "../lib/router.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { Graph } from "./Graph.js";
import { NewTaskDialog } from "./NewTaskDialog.js";
import { Empty, ErrorBox, Loading, StateBadge } from "./ui.js";

export function ProjectPage({ id, tab }: { id: string; tab: "board" | "graph" | "activity" }) {
  const [project, projectError] = useLiveQuery(() => api.project(id), [id], () => false);
  const [tasks, tasksError] = useLiveQuery(
    () => api.tasks(id),
    [id],
    (e) => e.projectId === id && (e.type === "TaskStateChanged" || e.type === "TaskCreated" || e.type === "PullRequestOpened"),
  );
  const [creating, setCreating] = useState(false);

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
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          New task
        </button>
      </header>

      <nav className="tabs">
        <a className={tab === "board" ? "active" : ""} href={href.project(id)}>
          Board
        </a>
        <a className={tab === "graph" ? "active" : ""} href={href.project(id, "graph")}>
          Graph
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
      ) : (
        <ActivityFeed projectId={id} limit={100} />
      )}

      {creating && tasks && (
        <NewTaskDialog project={project} tasks={tasks} onClose={() => setCreating(false)} />
      )}
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
