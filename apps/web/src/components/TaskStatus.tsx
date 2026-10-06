import type { ApprovalDto, DecisionDto, TaskDto } from "@mar/core";
import type { ReactNode } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { href } from "../lib/router.js";

/**
 * Where the task is, what it waits for and what (if anything) a person should
 * do, in one line at the top of the task page: no state leaves a person guessing.
 */
export function TaskStatus({
  task,
  approvals,
  decisions,
  hasStuckCard,
}: {
  task: TaskDto;
  approvals: ApprovalDto[] | undefined;
  decisions: DecisionDto[] | undefined;
  hasStuckCard: boolean;
}) {
  const waiting = task.state === "CREATED" || task.state === "READY";
  const [deps] = useLiveQuery(
    () => Promise.all(task.dependsOn.map((id) => api.task(id))),
    [task.dependsOn.join()],
    (e) => task.dependsOn.includes(e.taskId ?? ""),
  );
  const [runners] = useLiveQuery(() => (waiting ? api.runners() : Promise.resolve(undefined)), [waiting], (e) => e.type === "RunnerRegistered");
  const [queue] = useLiveQuery(() => (task.state === "READY" ? api.queue(task.projectId) : Promise.resolve(undefined)), [task.state], (e) => e.type === "TaskStateChanged");
  const [reviewers] = useLiveQuery(
    () => (task.state === "REVIEW" ? api.tasks(task.projectId).then((all) => all.filter((t) => t.reviewOf === task.id && t.state !== "COMPLETED" && t.state !== "CANCELLED")) : Promise.resolve([])),
    [task.state],
    (e) => e.type === "TaskStateChanged",
  );

  const message = ((): { tone: "info" | "you" | "done"; text: ReactNode } | null => {
    switch (task.state) {
      case "CREATED": {
        const open = (deps ?? []).filter((d) => d.state !== "COMPLETED");
        return {
          tone: "info",
          text: (
            <>
              Waits for {open.length ? <TaskLinks tasks={open} /> : "its dependencies"} to be merged; then it starts on its own.
            </>
          ),
        };
      }
      case "READY": {
        if (task.agent === "human") return { tone: "you", text: "A person does this task: see “For a person” below." };
        const online = (runners ?? []).filter((r) => r.online);
        const offered = new Set(online.flatMap((r) => r.agents.map((a) => a.id)));
        if (runners && !online.length) {
          return { tone: "you", text: <>No runner is online, so nobody can take it. Start a runner (see the <a href={href.overview()}>overview</a>).</> };
        }
        if (runners && task.agent !== "auto" && !offered.has(task.agent)) {
          return {
            tone: "you",
            text: (
              <>
                No online runner offers <span className="mono">{task.agent}</span>: start a runner that has it, or cancel and give the task to
                another agent.
              </>
            ),
          };
        }
        const entry = queue?.findIndex((e) => e.taskId === task.id) ?? -1;
        const blockedBy = entry >= 0 ? queue![entry]!.blockedBy : null;
        if (blockedBy) return { tone: "info", text: <>Waits for {blockedBy.key}, which works on the same files ({blockedBy.path}).</> };
        return { tone: "info", text: entry > 0 ? `Queued: #${entry + 1} in line for a free runner slot.` : "Next in line: a runner picks it up within seconds." };
      }
      case "ASSIGNED":
      case "RUNNING":
        return { tone: "info", text: "The agent is working. Follow it in the console; send an instruction or pause it if it goes the wrong way." };
      case "VALIDATING":
        return { tone: "info", text: "The agent finished; the project's validation commands are running." };
      case "REVIEW":
        return reviewers?.length
          ? { tone: "info", text: <>Agent review first: <TaskLinks tasks={reviewers} />. Then it is your turn here.</> }
          : { tone: "you", text: "Your turn: read the contract checklist, the diff and the handoff, then Approve & merge or Request changes (top right)." };
      case "APPROVED":
      case "MERGING":
        return { tone: "info", text: "Approved: in the merge queue (it waits for the branch, CI and earlier merges)." };
      case "WAITING_FOR_HUMAN": {
        if (approvals?.some((a) => a.status === "pending")) return { tone: "you", text: "Your turn: the agent waits for an approval below (Approvals)." };
        if (decisions?.some((d) => d.status === "pending")) return { tone: "you", text: "Your turn: the agent asked a question below (Questions)." };
        return hasStuckCard ? null : { tone: "you", text: "Waits for a person: see the timeline for why, then Retry or Cancel (top right)." };
      }
      case "REWORK":
      case "RETRYING":
        return { tone: "info", text: "Goes back to the agent with what went wrong (see the timeline); it restarts on its own." };
      case "PAUSED":
        return { tone: "you", text: "Paused: look at the diff, send an instruction if needed, then Resume (top right)." };
      case "BLOCKED":
        return hasStuckCard ? null : { tone: "you", text: "Blocked after too many failures: see why below, then Retry or Cancel." };
      case "WAITING_FOR_AGENT":
        return { tone: "info", text: "The agent is unavailable for now (quota or sign-in); it resumes when the agent is back." };
      case "COMPLETED":
        return { tone: "done", text: "Done: merged into the base branch." };
      case "CANCELLED":
        return { tone: "done", text: "Cancelled." };
      default:
        return null;
    }
  })();
  if (!message) return null;
  return <div className={`notice task-status status-${message.tone}`}>{message.text}</div>;
}

function TaskLinks({ tasks }: { tasks: TaskDto[] }) {
  return (
    <>
      {tasks.map((t, i) => (
        <span key={t.id}>
          {i > 0 && ", "}
          <a href={href.task(t.id)}>
            <span className="mono">{t.key}</span> {t.title}
          </a>
        </span>
      ))}
    </>
  );
}
