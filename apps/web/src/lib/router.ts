import { useSyncExternalStore } from "react";

/** Hash routes (#/projects/<id>) so the UI never collides with API paths. */
export type Route =
  | { page: "overview" }
  | { page: "project"; id: string; tab: "board" | "graph" | "activity" }
  | { page: "task"; id: string }
  | { page: "approvals" }
  | { page: "agents" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) {
    const tab = parts[2] === "graph" || parts[2] === "activity" ? parts[2] : "board";
    return { page: "project", id: parts[1], tab };
  }
  if (parts[0] === "tasks" && parts[1]) return { page: "task", id: parts[1] };
  if (parts[0] === "approvals") return { page: "approvals" };
  if (parts[0] === "agents") return { page: "agents" };
  return { page: "overview" };
}

export const href = {
  overview: () => "#/",
  project: (id: string, tab?: "board" | "graph" | "activity") => `#/projects/${id}${tab && tab !== "board" ? `/${tab}` : ""}`,
  task: (id: string) => `#/tasks/${id}`,
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
