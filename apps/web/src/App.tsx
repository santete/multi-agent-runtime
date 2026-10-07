import type { ActorDto } from "@mar/core";
import { useEffect, useState } from "react";
import { AgentsPage } from "./components/AgentsPage.js";
import { ApprovalsPage } from "./components/ApprovalsPage.js";
import { MarketplacePage } from "./components/MarketplacePage.js";
import { MetricsPage } from "./components/MetricsPage.js";
import { Login } from "./components/Login.js";
import { Overview } from "./components/Overview.js";
import { useWaitingCount } from "./lib/waiting.js";
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

const ICONS: Record<string, string> = {
  overview: "M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  agents: "M12 8V4H8M4 12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 15v.01M15 15v.01",
  marketplace: "M3 9l1-5h16l1 5M3 9v11h18V9M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0",
  metrics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  project: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
};

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

type Theme = "dark" | "light" | "system";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("mar-theme");
      return t === "dark" || t === "light" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem("mar-theme");
      else localStorage.setItem("mar-theme", theme);
    } catch {
      /* storage unavailable: the choice just lasts for this visit */
    }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === "system" ? "dark" : t === "dark" ? "light" : "system"));
  return [theme, cycle];
}

function Shell({ actor, onLogout }: { actor: ActorDto; onLogout: () => void }) {
  const route = useRoute();
  const status = useLiveStatus();
  const [projects] = useLiveQuery(api.projects, [], (e) => e.type === "ProjectCreated");
  // The inbox: everything that waits for a person (approvals, questions, plans, reviews, stuck work).
  const inbox = useWaitingCount() ?? 0;
  const [theme, cycleTheme] = useTheme();

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href={href.overview()}>
          <span className="brand-mark">◆</span> Multi-Agent Runtime
        </a>
        <nav>
          <a className={route.page === "overview" ? "active" : ""} href={href.overview()}>
            <NavIcon name="overview" /> Overview
          </a>
          <a className={route.page === "approvals" ? "active" : ""} href={href.approvals()}>
            <NavIcon name="inbox" /> Inbox {inbox ? <span className="count">{inbox}</span> : null}
          </a>
          <a className={route.page === "agents" ? "active" : ""} href={href.agents()}>
            <NavIcon name="agents" /> Agents
          </a>
          <a className={route.page === "marketplace" ? "active" : ""} href={href.marketplace()}>
            <NavIcon name="marketplace" /> Marketplace
          </a>
          <a className={route.page === "metrics" ? "active" : ""} href={href.metrics()}>
            <NavIcon name="metrics" /> Metrics
          </a>
          <div className="nav-title">Projects</div>
          {(projects ?? []).map((p) => (
            <a key={p.id} className={route.page === "project" && route.id === p.id ? "active" : ""} href={href.project(p.id)}>
              <NavIcon name="project" /> <span className="mono">{p.key}</span> {p.name}
            </a>
          ))}
        </nav>
        <footer className="sidebar-foot">
          <span className={`live-dot ${status}`} title={`event stream: ${status}`} />
          <span>
            {actor.name} <span className="muted">· {actor.role}{actor.org && actor.org !== "*" ? ` · ${actor.org}` : ""}</span>
          </span>
          <button className="theme-toggle" onClick={cycleTheme} title={"Theme: " + theme + " (click to change)"} aria-label={"Theme: " + theme}>
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </button>
          {actor.name !== "local" && (
            <button className="link" onClick={onLogout}>
              Sign out
            </button>
          )}
        </footer>
      </aside>
      <main className="main">
        {route.page === "overview" && <Overview actor={actor} />}
        {route.page === "project" && <ProjectPage id={route.id} tab={route.tab} actor={actor} />}
        {route.page === "task" && <TaskPage id={route.id} actor={actor} />}
        {route.page === "plan" && <PlanPage id={route.id} actor={actor} />}
        {route.page === "approvals" && <ApprovalsPage actor={actor} />}
        {route.page === "agents" && <AgentsPage actor={actor} />}
        {route.page === "marketplace" && <MarketplacePage actor={actor} />}
        {route.page === "metrics" && <MetricsPage />}
      </main>
    </div>
  );
}
