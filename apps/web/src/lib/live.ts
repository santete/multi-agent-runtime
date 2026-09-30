import type { EventDto } from "@mar/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { authHeaders } from "./api.js";

type Listener = (event: EventDto) => void;

/**
 * One server-sent event connection for the whole app (fetch-based so it can
 * send the Authorization header). Reconnects with backoff and resumes after
 * the last seen event id.
 */
class LiveEvents {
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<() => void>();
  private status: "connecting" | "live" | "offline" = "connecting";
  private lastSeq: number | undefined;
  private started = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      void this.loop();
    }
    return () => this.listeners.delete(listener);
  }

  getStatus = () => this.status;

  subscribeStatus = (cb: () => void) => {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  };

  private setStatus(status: LiveEvents["status"]) {
    this.status = status;
    for (const cb of this.statusListeners) cb();
  }

  private async loop(): Promise<void> {
    let delay = 1000;
    for (;;) {
      try {
        const query = this.lastSeq !== undefined ? `?after=${this.lastSeq}` : "";
        const res = await fetch(`/stream${query}`, { headers: authHeaders() });
        if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
        this.setStatus("live");
        delay = 1000;
        await this.read(res.body);
      } catch {
        // fall through to reconnect
      }
      this.setStatus("offline");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as EventDto;
        this.lastSeq = event.seq;
        for (const listener of this.listeners) listener(event);
      }
    }
  }
}

export const live = new LiveEvents();

export function useLiveStatus() {
  return useSyncExternalStore(live.subscribeStatus, live.getStatus);
}

/** Calls `onEvent` for every live event (the latest callback is used). */
export function useLiveEvents(onEvent: Listener): void {
  const [ref] = useState(() => ({ current: onEvent }));
  ref.current = onEvent;
  useEffect(() => live.subscribe((e) => ref.current(e)), [ref]);
}

/**
 * Loads data and reloads it (debounced) whenever a live event matches.
 * Returns [data, error, reload].
 */
export function useLiveQuery<T>(
  load: () => Promise<T>,
  deps: unknown[],
  matches: (e: EventDto) => boolean = () => true,
): [T | undefined, Error | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [version, setVersion] = useState(0);
  const [timer] = useState<{ id?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    let cancelled = false;
    load().then(
      (d) => {
        if (!cancelled) {
          setData(d);
          setError(undefined);
        }
      },
      (e: Error) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  useLiveEvents((e) => {
    if (!matches(e)) return;
    clearTimeout(timer.id);
    timer.id = setTimeout(() => setVersion((v) => v + 1), 250);
  });

  return [data, error, () => setVersion((v) => v + 1)];
}
