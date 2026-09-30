import type { ProjectDto, TaskDto } from "@mar/core";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { COLUMNS, groupByColumn } from "../lib/model.js";
import { href } from "../lib/router.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { Empty, ErrorBox, Loading, Section } from "./ui.js";

type ProjectSummary = { project: ProjectDto; tasks: TaskDto[] };

async function loadSummaries(): Promise<ProjectSummary[]> {
  const projects = await api.projects();
  return Promise.all(projects.map(async (project) => ({ project, tasks: await api.tasks(project.id) })));
}

export function Overview() {
  const [summaries, error] = useLiveQuery(loadSummaries, [], (e) => e.type === "TaskStateChanged" || e.type === "TaskCreated" || e.type === "ProjectCreated");
  const [runners] = useLiveQuery(api.runners, [], (e) => e.type === "RunnerRegistered" || e.type === "ExecutionAssigned" || e.type === "AgentFinished");
  const [pending] = useLiveQuery(() => api.approvals("pending"), [], (e) => e.type.startsWith("Approval"));

  const online = runners?.filter((r) => r.online) ?? [];
  const working = runners?.flatMap((r) => r.activeExecutions) ?? [];

  return (
    <div className="page">
      <h1>Overview</h1>
      <div className="stats">
        <a className="stat" href={href.agents()}>
          <span className="stat-value">{online.length}</span>
          <span className="stat-label">runners online</span>
        </a>
        <a className="stat" href={href.agents()}>
          <span className="stat-value">{working.length}</span>
          <span className="stat-label">agents working</span>
        </a>
        <a className={`stat ${pending?.length ? "stat-attention" : ""}`} href={href.approvals()}>
          <span className="stat-value">{pending?.length ?? 0}</span>
          <span className="stat-label">approvals waiting</span>
        </a>
      </div>

      <Section title="Projects">
        <ErrorBox error={error} />
        {!summaries ? (
          <Loading />
        ) : summaries.length === 0 ? (
          <Empty>No projects yet. Create one with POST /projects (owner role).</Empty>
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
