import type { EventDto } from "@mar/core";
import type { Store } from "./store.js";

/**
 * Notifications (spec §31): tells people when the team needs them — an
 * approval, a review, a plan to decide on, a blocked task — by posting to
 * Slack-compatible incoming webhooks (Slack, Mattermost, Rocket.Chat,
 * Discord's /slack endpoint, or anything that accepts `{text}`).
 */
export type NotificationKind = "approval" | "review" | "plan" | "blocked" | "ci" | "merged";

export const DEFAULT_NOTIFICATIONS: NotificationKind[] = ["approval", "review", "plan", "blocked"];

export interface NotifierOptions {
  webhooks: string[];
  kinds?: NotificationKind[] | undefined;
  /** Base URL of the dashboard for links, e.g. https://mar.example.com. */
  publicUrl: string;
  fetchImpl?: typeof fetch;
  /** Delays between delivery attempts; one attempt more than entries. */
  retryDelaysMs?: number[];
  log?: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
}

export interface Notification {
  kind: NotificationKind;
  /** Plain text (Slack mrkdwn): the message and a link. */
  text: string;
}

/** Name of this consumer's cursor in the event log. */
const CURSOR = "notifier";

export class Notifier {
  private readonly kinds: Set<NotificationKind>;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly store: Store,
    private readonly options: NotifierOptions,
  ) {
    this.kinds = new Set(options.kinds ?? DEFAULT_NOTIFICATIONS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 5000];
  }

  /**
   * Notifies about the events appended since the last call. The cursor lives
   * in the database, so a restart neither repeats nor skips notifications;
   * the first run starts at the end of the log instead of replaying history.
   */
  async poll(limit = 200): Promise<number> {
    let cursor = await this.store.eventCursor(CURSOR);
    if (cursor === null) {
      await this.store.setEventCursor(CURSOR, await this.store.latestEventSeq());
      return 0;
    }
    const events = await this.store.listEvents({}, cursor, limit);
    let sent = 0;
    for (const event of events) {
      const notification = await this.describe(event).catch((err) => {
        this.options.log?.error({ err: String(err), event: event.seq }, "notification skipped");
        return null;
      });
      if (notification && this.kinds.has(notification.kind)) {
        await Promise.all(this.options.webhooks.map((url) => this.post(url, notification, event)));
        sent++;
      }
      cursor = event.seq;
      await this.store.setEventCursor(CURSOR, cursor);
    }
    return sent;
  }

  /** The notification for an event, or null when nobody needs to hear about it. */
  async describe(e: EventDto): Promise<Notification | null> {
    const p = e.payload as Record<string, any>;
    const task = e.taskId ? await this.store.getTask(e.taskId) : undefined;
    const name = task ? `*${task.key}* ${task.title}` : "";
    const taskLink = task ? this.link(`#/tasks/${task.id}`, "Open task") : "";

    switch (e.type) {
      case "ApprovalRequested":
        return {
          kind: "approval",
          text: `:warning: *Approval needed* (${p.risk ?? "HIGH"}) — ${name}: the agent wants to run \`${p.summary}\`. ${this.link("#/approvals", "Review approvals")}`,
        };
      case "TaskStateChanged":
        if (!task) return null;
        if (p.to === "REVIEW" && task.kind === "work") {
          const pr = task.pullRequestUrl ? ` <${task.pullRequestUrl}|PR #${task.pullRequestNumber}>` : "";
          return { kind: "review", text: `:eyes: *Review needed* — ${name} by \`${task.agent}\`.${pr} ${taskLink}` };
        }
        if (p.to === "BLOCKED" || (p.to === "WAITING_FOR_HUMAN" && p.from !== "WAITING_FOR_HUMAN")) {
          const why = p.to === "BLOCKED" ? "is blocked (attempts used up)" : "is waiting for a person";
          return { kind: "blocked", text: `:octagonal_sign: ${name} ${why}. ${taskLink}` };
        }
        return null;
      case "PlanProposed": {
        const plan = await this.store.getPlan(p.planId);
        return {
          kind: "plan",
          text: `:clipboard: *Plan ready for review* — ${p.tasks} task(s) for “${oneLine(plan.goal, 120)}”. ${this.link(`#/plans/${plan.id}`, "Open plan")}`,
        };
      }
      case "CiFailed":
        return { kind: "ci", text: `:x: CI failed for ${name}: ${(p.checks ?? []).join(", ")}. The agent is reworking it. ${taskLink}` };
      case "TaskMerged":
        return { kind: "merged", text: `:white_check_mark: ${name} merged${task?.pullRequestUrl ? ` (<${task.pullRequestUrl}|PR>)` : ""}.` };
      default:
        return null;
    }
  }

  private link(hash: string, label: string): string {
    return `<${this.options.publicUrl.replace(/\/$/, "")}/ui/${hash}|${label}>`;
  }

  /** Posts with retries on network errors and 5xx/429; other client errors are not retried. */
  private async post(url: string, n: Notification, event: EventDto): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let status: number | undefined;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: n.text }),
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        if (res.ok) return;
      } catch {
        // network error: retried below
      }
      const retryable = status === undefined || status === 429 || status >= 500;
      const delay = this.retryDelaysMs[attempt];
      if (!retryable || delay === undefined) {
        // The webhook URL is a secret: log only its host.
        this.options.log?.error({ host: safeHost(url), status: status ?? null, event: event.seq, kind: n.kind }, "notification failed");
        return;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
}

/** Reads MAR_NOTIFY_WEBHOOKS / MAR_NOTIFY_EVENTS; null when notifications are off. */
export function notifierOptionsFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): NotifierOptions | null {
  const webhooks = (env.MAR_NOTIFY_WEBHOOKS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!webhooks.length) return null;
  const all: NotificationKind[] = ["approval", "review", "plan", "blocked", "ci", "merged"];
  const kinds = env.MAR_NOTIFY_EVENTS
    ? env.MAR_NOTIFY_EVENTS.split(",")
        .map((s) => s.trim())
        .filter((s): s is NotificationKind => all.includes(s as NotificationKind))
    : undefined;
  return { webhooks, kinds, publicUrl: env.MAR_PUBLIC_URL || publicUrl };
}
