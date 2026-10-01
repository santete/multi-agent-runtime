import type { ActorDto } from "@mar/core";
import { useEffect, useState } from "react";
import { AgentsPage } from "./components/AgentsPage.js";
import { ApprovalsPage } from "./components/ApprovalsPage.js";
import { MarketplacePage } from "./components/MarketplacePage.js";
import { Login } from "./components/Login.js";
import { Overview } from "./components/Overview.js";
import { PlanPage } from "./components/PlansPage.js";
import { ProjectPage } from "./components/ProjectPage.js";
import { TaskPage } from "./components/TaskPage.js";
import { api, setToken } from "./lib/api.js";
import { useLiveQuery, useLiveStatus } from "./lib/live.js";
import { href, useRoute } from "./lib/router.js";

export function App() {
  const [actor, setActor] = useState<ActorDto | null>();

  useEffect(() => {
    // Open mode answers without a token; otherwise a stored token may still be valid.
    api.me().then(setActor, () => setActor(null));
  }, []);

  if (actor === undefined) return <p className="empty">Connecting…</p>;
  if (actor === null) return <Login onLogin={setActor} />;
  return <Shell actor={actor} onLogout={() => (setToken(null), setActor(null))} />;
}

function Shell({ actor, onLogout }: { actor: ActorDto; onLogout: () => void }) {
  const route = useRoute();
  const status = useLiveStatus();
  const [projects] = useLiveQuery(api.projects, [], (e) => e.type === "ProjectCreated");
  const [pending] = useLiveQuery(() => api.approvals("pending"), [], (e) => e.type.startsWith("Approval"));
  // The inbox: approvals, agents' questions and tasks for a person (spec §61).
  const humanEvent = (e: { type: string }) => e.type.startsWith("Decision") || e.type === "TaskStateChanged";
  const [questions] = useLiveQuery(() => api.decisions({ status: "pending" }), [], humanEvent);
  const [humanTasks] = useLiveQuery(api.humanTasks, [], humanEvent);
  const inbox = (pending?.length ?? 0) + (questions?.length ?? 0) + (humanTasks?.length ?? 0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href={href.overview()}>
          <span className="brand-mark">◆</span> Multi-Agent Runtime
        </a>
        <nav>
          <a className={route.page === "overview" ? "active" : ""} href={href.overview()}>
            Overview
          </a>
          <a className={route.page === "approvals" ? "active" : ""} href={href.approvals()}>
            Inbox {inbox ? <span className="count">{inbox}</span> : null}
          </a>
          <a className={route.page === "agents" ? "active" : ""} href={href.agents()}>
            Agents
          </a>
          <a className={route.page === "marketplace" ? "active" : ""} href={href.marketplace()}>
            Marketplace
          </a>
          <div className="nav-title">Projects</div>
          {(projects ?? []).map((p) => (
            <a key={p.id} className={route.page === "project" && route.id === p.id ? "active" : ""} href={href.project(p.id)}>
              <span className="mono">{p.key}</span> {p.name}
            </a>
          ))}
        </nav>
        <footer className="sidebar-foot">
          <span className={`live-dot ${status}`} title={`event stream: ${status}`} />
          <span>
            {actor.name} <span className="muted">· {actor.role}{actor.org && actor.org !== "*" ? ` · ${actor.org}` : ""}</span>
          </span>
          {actor.name !== "local" && (
            <button className="link" onClick={onLogout}>
              Sign out
            </button>
          )}
        </footer>
      </aside>
      <main className="main">
        {route.page === "overview" && <Overview />}
        {route.page === "project" && <ProjectPage id={route.id} tab={route.tab} actor={actor} />}
        {route.page === "task" && <TaskPage id={route.id} actor={actor} />}
        {route.page === "plan" && <PlanPage id={route.id} actor={actor} />}
        {route.page === "approvals" && <ApprovalsPage actor={actor} />}
        {route.page === "agents" && <AgentsPage actor={actor} />}
        {route.page === "marketplace" && <MarketplacePage actor={actor} />}
      </main>
    </div>
  );
}
