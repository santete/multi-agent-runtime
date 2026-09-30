import type {
  AgentEvent,
  ClaimResponse,
  CompleteExecutionRequest,
  ExecutionDto,
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
  constructor(private readonly baseUrl: string) {}

  async register(name: string, agents: string[]): Promise<string> {
    const res = await this.post<RegisterRunnerResponse>("/runners/register", { name, agents });
    return res!.runnerId;
  }

  claim(runnerId: string): Promise<ClaimResponse | undefined> {
    return this.post<ClaimResponse>(`/runners/${runnerId}/claim`);
  }

  async start(executionId: string, workspace: string, branch: string): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/start`, { workspace, branch }))!;
  }

  async appendEvents(executionId: string, events: AgentEvent[]): Promise<void> {
    await this.post(`/executions/${executionId}/events`, { events });
  }

  async complete(executionId: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/complete`, req))!;
  }

  /** Returns undefined for 204 No Content. */
  private async post<T>(path: string, body?: unknown): Promise<T | undefined> {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined;
    if (!res.ok) throw new ControlPlaneError(res.status, await res.text(), path);
    return (await res.json()) as T;
  }
}
