import { useSyncExternalStore } from "react";

export type ProjectTab = "board" | "graph" | "plans" | "knowledge" | "costs" | "activity";

/** Hash routes (#/projects/<id>) so the UI never collides with API paths. */
export type Route =
  | { page: "overview" }
  | { page: "project"; id: string; tab: ProjectTab }
  | { page: "task"; id: string }
  | { page: "plan"; id: string }
  | { page: "approvals" }
  | { page: "agents" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) {
    const tabs: ProjectTab[] = ["graph", "plans", "knowledge", "costs", "activity"];
    const tab = tabs.find((t) => t === parts[2]) ?? "board";
    return { page: "project", id: parts[1], tab };
  }
  if (parts[0] === "tasks" && parts[1]) return { page: "task", id: parts[1] };
  if (parts[0] === "plans" && parts[1]) return { page: "plan", id: parts[1] };
  if (parts[0] === "approvals") return { page: "approvals" };
  if (parts[0] === "agents") return { page: "agents" };
  return { page: "overview" };
}

export const href = {
  overview: () => "#/",
  project: (id: string, tab?: ProjectTab) => `#/projects/${id}${tab && tab !== "board" ? `/${tab}` : ""}`,
  task: (id: string) => `#/tasks/${id}`,
  plan: (id: string) => `#/plans/${id}`,
  approvals: () => "#/approvals",
  agents: () => "#/agents",
};

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
