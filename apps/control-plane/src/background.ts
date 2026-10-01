import type { LeaderLock } from "./db.js";
import type { Notifier } from "./notifier.js";
import type { Store } from "./store.js";

/**
 * The control plane's background work: sweeping lost executions, the merge
 * queue, the base branch's health, escalations and notifications. Any number
 * of instances can serve the API, but only the one holding the leader lock
 * runs this (ADR-0033); the others stand by and take over when it goes away.
 */
export interface BackgroundOptions {
  store: Store;
  notifier: Notifier;
  leader: LeaderLock;
  sweepEveryMs?: number;
  notifyEveryMs?: number;
  escalate?: { readyMinutes: number; humanHours: number };
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: unknown, msg: string): void };
}

export class Background {
  private leading = false;
  private running = { housekeeping: false, notify: false };
  private timers: NodeJS.Timeout[] = [];
  /** Both loops ask for leadership; one check at a time. */
  private leadership: Promise<boolean> = Promise.resolve(false);

  constructor(private readonly options: BackgroundOptions) {}

  /** Whether this instance currently runs the background work. */
  get isLeader(): boolean {
    return this.leading;
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.housekeeping(), this.options.sweepEveryMs ?? 5000),
      setInterval(() => void this.notify(), this.options.notifyEveryMs ?? 3000),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.options.leader.release();
    this.leading = false;
  }

  /** Takes or confirms leadership; false means another instance leads. */
  private lead(): Promise<boolean> {
    this.leadership = this.leadership.then(() => this.checkLeadership(), () => this.checkLeadership());
    return this.leadership;
  }

  private async checkLeadership(): Promise<boolean> {
    const holds = await this.options.leader.hold();
    if (holds && !this.leading) {
      this.options.log?.info({}, "background work: this instance is the leader");
      // Runners could not heartbeat while no instance led (e.g. all were down): renew their leases before sweeping.
      const extended = await this.options.store.extendActiveLeases();
      if (extended) this.options.log?.info({ executions: extended }, "active leases extended on taking the lead");
    } else if (!holds && this.leading) {
      this.options.log?.warn({}, "background work: lost the leader lock, standing by");
    }
    this.leading = holds;
    return holds;
  }

  /** One round of housekeeping (public for tests). */
  async housekeeping(): Promise<boolean> {
    if (this.running.housekeeping) return false;
    this.running.housekeeping = true;
    try {
      if (!(await this.lead())) return false;
      const { store, log } = this.options;
      const r = await store.sweep();
      if (r.lost || r.requeued || r.blocked) log?.info(r, "sweep");
      const m = await store.processMergeQueue();
      if (m.merged || m.conflicts || m.failed) log?.info(m, "merge queue");
      // Self-healing (spec §46): the base branch's CI after merges, and work that stopped moving.
      const h = await store.checkMergedCommits();
      if (h.broken) log?.warn(h, "base branch broken after a merge");
      await store.escalateStuck(this.options.escalate ?? { readyMinutes: 30, humanHours: 8 });
      return true;
    } catch (err) {
      this.options.log?.error(err, "housekeeping failed");
      return false;
    } finally {
      this.running.housekeeping = false;
    }
  }

  /** One round of notifications (public for tests). */
  async notify(): Promise<number> {
    if (this.running.notify) return 0;
    this.running.notify = true;
    try {
      if (!(await this.lead())) return 0;
      return await this.options.notifier.poll();
    } catch (err) {
      this.options.log?.error(err, "notifications failed");
      return 0;
    } finally {
      this.running.notify = false;
    }
  }
}
