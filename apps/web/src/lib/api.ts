import type {
  ActorDto,
  AgentCooldown,
  AgentSkillStats,
  AgentStats,
  Budget,
  CostReport,
  ApprovalDto,
  ArtifactDto,
  KnowledgeDto,
  KnowledgeKind,
  KnowledgeStatus,
  PlanDto,
  PlanningPolicy,
  PlannedTask,
  EventDto,
  EventsPage,
  ExecutionDto,
  ProjectDto,
  RunnerDto,
  TaskDto,
  TaskGraph,
} from "@mar/core";

const TOKEN_KEY = "mar.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: the token lives for this page only
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.message ?? data.error ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);

export const api = {
  me: () => get<ActorDto>("/me"),
  projects: () => get<ProjectDto[]>("/projects"),
  project: (id: string) => get<ProjectDto>(`/projects/${id}`),
  tasks: (projectId: string) => get<TaskDto[]>(`/projects/${projectId}/tasks`),
  graph: (projectId: string) => get<TaskGraph>(`/projects/${projectId}/graph`),
  projectEvents: (projectId: string, after = 0, limit = 200) =>
    get<EventsPage>(`/projects/${projectId}/events?after=${after}&limit=${limit}`),
  createTask: (
    projectId: string,
    body: { title: string; objective: string; agent: string; dependsOn?: string[]; requires?: string[]; fallbackAgents?: string[] },
  ) =>
    post<TaskDto>(`/projects/${projectId}/tasks`, body),

  plans: (projectId: string) => get<PlanDto[]>(`/projects/${projectId}/plans`),
  plan: (id: string) => get<PlanDto>(`/plans/${id}`),
  createPlan: (projectId: string, body: { goal: string; agent: string }) => post<PlanDto>(`/projects/${projectId}/plans`, body),
  approvePlan: (id: string, body: { tasks?: PlannedTask[]; comment?: string }) => post<PlanDto>(`/plans/${id}/approve`, body),
  revisePlan: (id: string, feedback: string) => post<PlanDto>(`/plans/${id}/revise`, { feedback }),
  rejectPlan: (id: string, comment?: string) => post<PlanDto>(`/plans/${id}/reject`, comment ? { comment } : {}),

  knowledge: (projectId: string) => get<KnowledgeDto[]>(`/projects/${projectId}/knowledge`),
  createKnowledge: (projectId: string, body: { kind: KnowledgeKind; title: string; body: string }) =>
    post<KnowledgeDto>(`/projects/${projectId}/knowledge`, body),
  updateKnowledge: (id: string, body: { kind?: KnowledgeKind; title?: string; body?: string; status?: KnowledgeStatus }) =>
    put<KnowledgeDto>(`/knowledge/${id}`, body),

  task: (id: string) => get<TaskDto>(`/tasks/${id}`),
  taskEvents: (id: string) => get<EventsPage>(`/tasks/${id}/events?limit=1000`),
  executions: (taskId: string) => get<ExecutionDto[]>(`/tasks/${taskId}/executions`),
  artifacts: (taskId: string) => get<ArtifactDto[]>(`/tasks/${taskId}/artifacts`),
  taskApprovals: (taskId: string) => get<ApprovalDto[]>(`/tasks/${taskId}/approvals`),
  review: (taskId: string, decision: "approve" | "reject", comment?: string) =>
    post<TaskDto>(`/tasks/${taskId}/review`, { decision, ...(comment && { comment }) }),
  retry: (taskId: string) => post<TaskDto>(`/tasks/${taskId}/retry`),
  cancel: (taskId: string) => post<TaskDto>(`/tasks/${taskId}/cancel`),

  executionEvents: (executionId: string, after = 0) =>
    get<EventsPage>(`/executions/${executionId}/events?after=${after}&limit=1000`),

  approvals: (status?: "pending" | "approved" | "rejected") =>
    get<ApprovalDto[]>(`/approvals${status ? `?status=${status}` : ""}`),
  decide: (id: string, decision: "approve" | "reject", comment?: string) =>
    post<ApprovalDto>(`/approvals/${id}/${decision}`, comment ? { comment } : {}),

  runners: () => get<RunnerDto[]>("/runners"),
  agentStats: () => get<AgentStats[]>("/agents/stats"),
  cooldowns: () => get<AgentCooldown[]>("/agents/cooldowns"),
  skillStats: () => get<AgentSkillStats[]>("/agents/skill-stats"),
  clearCooldown: (runnerId: string, agent: string) => request<void>("DELETE", `/runners/${runnerId}/cooldowns/${encodeURIComponent(agent)}`),
  costs: (projectId: string) => get<CostReport>(`/projects/${projectId}/costs`),
  setBudget: (projectId: string, budget: Budget | null) => put<ProjectDto>(`/projects/${projectId}/budget`, budget),
  setPlanning: (projectId: string, planning: PlanningPolicy) => put<ProjectDto>(`/projects/${projectId}/planning`, planning),
  recentEvents: (limit = 50, projectId?: string) =>
    get<EventDto[]>(`/events/recent?limit=${limit}${projectId ? `&projectId=${projectId}` : ""}`),
};

export type { EventDto };
