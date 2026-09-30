import type { EventDto, ExecutionDto } from "@mar/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { useLiveEvents } from "../lib/live.js";
import { describeEvent } from "../lib/model.js";

/**
 * Live log of one execution (spec §43): agent messages, tool calls, policy
 * decisions and diagnostics as they stream in.
 */
export function AgentConsole({ execution }: { execution: ExecutionDto }) {
  const [events, setEvents] = useState<EventDto[]>([]);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    (async () => {
      let after = 0;
      const all: EventDto[] = [];
      for (;;) {
        const page = await api.executionEvents(execution.id, after);
        all.push(...page.events);
        if (page.events.length < 1000) break;
        after = page.nextAfter;
      }
      if (!cancelled) setEvents(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [execution.id]);

  useLiveEvents((e) => {
    if (e.executionId !== execution.id) return;
    setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
  });

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [events, follow]);

  return (
    <div className="console-wrap">
      <div className="console-bar">
        <span className="muted small">
          {execution.workspace ? <span className="mono">{execution.branch}</span> : "not started"} · {events.length} events
        </span>
        <label className="check small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
      </div>
      <div className="console">
        {events.map((e) => (
          <div key={e.seq} className={`line ${lineClass(e)}`}>
            <span className="line-kind">{kindOf(e)}</span>
            <span className="line-text">{describeEvent(e)}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function kindOf(e: EventDto): string {
  if (e.type === "AgentEvent") return String(e.payload.kind).replace("_", " ");
  if (e.type === "ToolCallChecked") return "policy";
  return e.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function lineClass(e: EventDto): string {
  const p = e.payload;
  if (e.type === "ToolCallChecked") return p.decision === "allow" ? "policy-allow" : "policy-deny";
  if (e.type !== "AgentEvent") return "system";
  if (p.kind === "message") return "message";
  if (p.kind === "tool_call") return "tool";
  if (p.kind === "tool_result") return p.ok ? "tool-ok" : "tool-error";
  if (p.kind === "failed" || p.kind === "permission_denied") return "error-line";
  if (p.kind === "completed") return p.success ? "done" : "error-line";
  return "system";
}
