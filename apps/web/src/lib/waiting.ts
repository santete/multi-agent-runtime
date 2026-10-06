import { api } from "./api.js";
import { useLiveQuery } from "./live.js";

/** Everything in the Inbox: what waits for a person, across projects. */
async function countWaiting(): Promise<number> {
  const [approvals, questions, humanTasks, stuck, waiting] = await Promise.all([
    api.approvals("pending"),
    api.decisions({ status: "pending" }),
    api.humanTasks(),
    api.stuckTasks(),
    api.waiting(),
  ]);
  return approvals.length + questions.length + humanTasks.length + stuck.length + waiting.plans.length + waiting.reviews.length;
}

const changesInbox = (e: { type: string }) =>
  e.type.startsWith("Approval") || e.type.startsWith("Decision") || e.type.startsWith("Plan") || e.type === "TaskStateChanged" || e.type === "ManualMergeNeeded";

export function useWaitingCount(): number | undefined {
  const [count] = useLiveQuery(countWaiting, [], changesInbox);
  return count;
}
