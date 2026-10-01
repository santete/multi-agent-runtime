import type {
  AgentDescriptor,
  AgentEvent,
  ClaimResponse,
  CompleteExecutionRequest,
  DeliveryRequest,
  DeliveryResponse,
  ExecutionDto,
  HeartbeatResponse,
  RegisterRunnerResponse,
  ValidationReport,
  ValidationResponse,
} from "@mar/core";
import { injectTraceHeaders } from "@mar/telemetry";

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

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** About two minutes of retries: enough to ride out a control plane restart. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 8, baseDelayMs: 500, maxDelayMs: 30_000 };

const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

export class ControlPlaneClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiToken?: string,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async register(name: string, agents: AgentDescriptor[]): Promise<string> {
    const res = await this.post<RegisterRunnerResponse>("/runners/register", { name, agents }, this.retry);
    return res!.runnerId;
  }

  /** Not retried: the poll loop simply tries again on its next tick. */
  claim(runnerId: string): Promise<ClaimResponse | undefined> {
    return this.post<ClaimResponse>(`/runners/${runnerId}/claim`);
  }

  async start(executionId: string, workspace: string, branch: string): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/start`, { workspace, branch }, this.retry))!;
  }

  /** Not retried: the next heartbeat follows shortly. */
  async heartbeat(executionId: string): Promise<HeartbeatResponse> {
    return (await this.post<HeartbeatResponse>(`/executions/${executionId}/heartbeat`))!;
  }

  async appendEvents(executionId: string, events: AgentEvent[]): Promise<void> {
    await this.post(`/executions/${executionId}/events`, { events }, this.retry);
  }

  // Results of finished work are retried so a control plane restart does not lose them.

  async complete(executionId: string, req: CompleteExecutionRequest): Promise<ExecutionDto> {
    return (await this.post<ExecutionDto>(`/executions/${executionId}/complete`, req, this.retry))!;
  }

  async validation(executionId: string, report: ValidationReport): Promise<ValidationResponse> {
    return (await this.post<ValidationResponse>(`/executions/${executionId}/validation`, report, this.retry))!;
  }

  async delivery(executionId: string, req: DeliveryRequest): Promise<DeliveryResponse> {
    return (await this.post<DeliveryResponse>(`/executions/${executionId}/delivery`, req, this.retry))!;
  }

  /** Task keys (of those given) whose tasks are finished, so their worktrees can go. */
  async finishedTasks(runnerId: string, taskKeys: string[]): Promise<string[]> {
    return (await this.post<string[]>(`/runners/${runnerId}/gc`, { taskKeys }))!;
  }

  /**
   * Returns undefined for 204 No Content. Network errors and 5xx responses are
   * retried with exponential backoff; 4xx responses are final.
   */
  private async post<T>(path: string, body?: unknown, retry: RetryPolicy = NO_RETRY): Promise<T | undefined> {
    const headers: Record<string, string> = {};
    if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    // The control plane's spans join the execution's trace.
    injectTraceHeaders(headers);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          method: "POST",
          headers,
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch (err) {
        if (attempt >= retry.attempts) throw err;
        await sleep(backoff(retry, attempt));
        continue;
      }
      if (res.status >= 500 && attempt < retry.attempts) {
        await sleep(backoff(retry, attempt));
        continue;
      }
      if (res.status === 204) return undefined;
      if (!res.ok) throw new ControlPlaneError(res.status, await res.text(), path);
      return (await res.json()) as T;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (p: RetryPolicy, attempt: number) => Math.min(p.baseDelayMs * 2 ** (attempt - 1), p.maxDelayMs);
