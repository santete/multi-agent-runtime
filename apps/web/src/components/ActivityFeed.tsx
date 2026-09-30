import type { EventDto } from "@mar/core";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { describeEvent, timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { Empty, ErrorBox, Loading } from "./ui.js";

/** Noisy per-step events (and allowed tool calls) are left to the agent console. */
const HIDDEN = new Set(["AgentEvent", "ArtifactCreated", "ExecutionStarted"]);
const shown = (e: EventDto) => !HIDDEN.has(e.type) && !(e.type === "ToolCallChecked" && e.payload.decision === "allow");

export function ActivityFeed({ projectId, limit = 40 }: { projectId?: string; limit?: number }) {
  const [events, error] = useLiveQuery(
    async () => (await api.recentEvents(limit * 5, projectId)).filter(shown).slice(0, limit),
    [projectId, limit],
    (e) => shown(e) && (!projectId || e.projectId === projectId),
  );
  if (error) return <ErrorBox error={error} />;
  if (!events) return <Loading />;
  if (!events.length) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <EventRow key={e.id} event={e} />
      ))}
    </ol>
  );
}

export function EventRow({ event, showTask = true }: { event: EventDto; showTask?: boolean }) {
  const important = event.type === "ApprovalRequested" || (event.type === "ToolCallChecked" && event.payload.decision === "deny");
  return (
    <li className={important ? "important" : ""}>
      <time title={event.createdAt}>{timeAgo(event.createdAt)}</time>
      {showTask && event.taskId && (
        <a className="mono" href={href.task(event.taskId)}>
          {event.taskKey ?? "task"}
        </a>
      )}
      <span className="event-type">{event.type}</span>
      <span className="event-text" title={describeEvent(event)}>
        {describeEvent(event)}
      </span>
    </li>
  );
}
