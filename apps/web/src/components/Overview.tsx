import type { ActorDto, ProjectDto, TaskDto } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { COLUMNS, groupByColumn } from "../lib/model.js";
import { href } from "../lib/router.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { NewProjectDialog } from "./NewProjectDialog.js";
import { useWaitingCount } from "../lib/waiting.js";
import { Empty, ErrorBox, Loading, Section } from "./ui.js";

type ProjectSummary = { project: ProjectDto; tasks: TaskDto[] };

async function loadSummaries(): Promise<ProjectSummary[]> {
  const projects = await api.projects();
  return Promise.all(projects.map(async (project) => ({ project, tasks: await api.tasks(project.id) })));
}

export function Overview({ actor }: { actor: ActorDto }) {
  const [creating, setCreating] = useState(false);
  const canCreate = actor.role === "owner";
  const [summaries, error] = useLiveQuery(loadSummaries, [], (e) => e.type === "TaskStateChanged" || e.type === "TaskCreated" || e.type === "ProjectCreated");
  const [runners] = useLiveQuery(api.runners, [], (e) => e.type === "RunnerRegistered" || e.type === "ExecutionAssigned" || e.type === "AgentFinished");
  const waiting = useWaitingCount();

  const online = runners?.filter((r) => r.online) ?? [];
  const working = runners?.flatMap((r) => r.activeExecutions) ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1>Overview</h1>
        {canCreate && (
          <div className="actions">
            <button className="primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
        )}
      </header>
      <div className="stats">
        <a className="stat" href={href.agents()}>
          <span className="stat-value">{online.length}</span>
          <span className="stat-label">runners online</span>
        </a>
        <a className="stat" href={href.agents()}>
          <span className="stat-value">{working.length}</span>
          <span className="stat-label">agents working</span>
        </a>
        <a className={`stat ${waiting ? "stat-attention" : ""}`} href={href.approvals()}>
          <span className="stat-value">{waiting ?? 0}</span>
          <span className="stat-label">waiting for you</span>
        </a>
      </div>
      {runners && online.length === 0 && (
        <div className="notice warning">
          <strong>No runner is online</strong>, so nothing will run. Start one on a machine where the agent CLIs are installed and signed in,
          from the repository root:
          <pre className="code small">{"copy apps\\runner\\runner.config.example.json runner.config.json\npnpm --filter @mar/runner start runner.config.json"}</pre>
          Keep only the agents installed on that machine in <span className="mono">runner.config.json</span>. See the user guide, section 2.
        </div>
      )}

      <Section title="Projects">
        <ErrorBox error={error} />
        {!summaries ? (
          <Loading />
        ) : summaries.length === 0 ? (
          <Empty>{canCreate ? "No projects yet. Create one with New project." : "No projects yet. An owner can create one."}</Empty>
        ) : (
          <div className="project-grid">
            {summaries.map(({ project, tasks }) => (
              <ProjectCard key={project.id} project={project} tasks={tasks} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent activity">
        <ActivityFeed />
      </Section>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function ProjectCard({ project, tasks }: ProjectSummary) {
  const groups = groupByColumn(tasks);
  const total = tasks.length || 1;
  return (
    <a className="card project-card" href={href.project(project.id)}>
      <div className="card-head">
        <span className="mono muted">{project.key}</span>
        <strong>{project.name}</strong>
      </div>
      <div className="stacked-bar" aria-label="tasks by status">
        {COLUMNS.map((c) =>
          groups[c.id].length ? (
            <span
              key={c.id}
              className={`seg col-${c.id}`}
              style={{ width: `${(groups[c.id].length / total) * 100}%` }}
              title={`${c.title}: ${groups[c.id].length}`}
            />
          ) : null,
        )}
      </div>
      <dl className="counts">
        {COLUMNS.filter((c) => groups[c.id].length).map((c) => (
          <div key={c.id}>
            <dt>{c.title}</dt>
            <dd>{groups[c.id].length}</dd>
          </div>
        ))}
        {!tasks.length && <span className="muted">No tasks</span>}
      </dl>
    </a>
  );
}
