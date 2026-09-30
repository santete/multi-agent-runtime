import type {
  AgentDescriptor,
  AgentEvent,
  ClaimResponse,
  CompleteExecutionRequest,
  ExecutionDto,
  HeartbeatResponse,
  RegisterRunnerResponse,
} from "@mar/core";

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`control plane ${path} -> HTTP ${status}: ${body}`);
    this.name = "ControlPlaneError";
  }
}

export class ControlPlaneClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiToken?: string,
  ) {}

  async register(name: string, agents: AgentDescriptor[]): Promise<string> {
    const res = await this.post<RegisterRunnerResponse>("/runners/register", { name, agents });
    return res!.runnerId;
  }

  claim(runnerId: string): Promise<ClaimResponse | undefined> {
    return this.post<ClaimResponse>(`/runners/${runnerId}/claim`);
  }

  async start(executionId: string, workspace: string, branch: string): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/start`, { workspace, branch }))!;
  }

  async heartbeat(executionId: string): Promise<HeartbeatResponse> {
    return (await this.post<HeartbeatResponse>(`/executions/${executionId}/heartbeat`))!;
  }

  async appendEvents(executionId: string, events: AgentEvent[]): Promise<void> {
    await this.post(`/executions/${executionId}/events`, { events });
  }

  async complete(executionId: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/complete`, req))!;
  }

  /** Returns undefined for 204 No Content. */
  private async post<T>(path: string, body?: unknown): Promise<T | undefined> {
    const headers: Record<string, string> = {};
    if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined;
    if (!res.ok) throw new ControlPlaneError(res.status, await res.text(), path);
    return (await res.json()) as T;
  }
}
