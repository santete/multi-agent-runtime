import { type ActorDto, KNOWLEDGE_KINDS, type KnowledgeDto, type KnowledgeKind, type KnowledgeStatus } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { timeAgo } from "../lib/model.js";
import { href } from "../lib/router.js";
import { Empty, ErrorBox, Loading, Pill } from "./ui.js";

const roleRank = { viewer: 0, member: 1, senior: 2, owner: 3, runner: -1 } as const;

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  architecture: "Architecture",
  business_rule: "Business rules",
  api_contract: "API contracts",
  data_model: "Data model",
  convention: "Conventions",
  decision: "Decisions",
  known_issue: "Known issues",
};

/** The project's shared knowledge (spec §20, §35): what agents learned and people wrote down. */
export function KnowledgeTab({ projectId, actor }: { projectId: string; actor: ActorDto }) {
  const [entries, error, reload] = useLiveQuery(
    () => api.knowledge(projectId),
    [projectId],
    (e) => e.projectId === projectId && e.type.startsWith("Knowledge"),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const canEdit = roleRank[actor.role] >= roleRank.member;

  if (error) return <ErrorBox error={error} />;
  if (!entries) return <Loading />;

  const proposed = entries.filter((k) => k.status === "proposed");
  const accepted = entries.filter((k) => k.status === "accepted");
  const archived = entries.filter((k) => k.status === "archived");

  return (
    <div className="knowledge">
      <div className="knowledge-bar">
        <p className="muted small">
          Every agent gets the accepted entries with its task. What an agent reports is accepted when its work is merged.
        </p>
        {canEdit && (
          <button className="primary" onClick={() => setAdding(true)}>
            Add knowledge
          </button>
        )}
      </div>
      {adding && <KnowledgeForm projectId={projectId} onDone={() => (setAdding(false), reload())} />}

      {proposed.length > 0 && (
        <section>
          <h3>Proposed by agents ({proposed.length})</h3>
          {proposed.map((k) => (
            <Entry key={k.id} entry={k} canEdit={canEdit} onChange={reload} />
          ))}
        </section>
      )}

      {accepted.length === 0 && proposed.length === 0 && (
        <Empty>No knowledge yet. Agents add what they learn about the project as they work, or add it yourself.</Empty>
      )}
      {KNOWLEDGE_KINDS.map((kind) => {
        const group = accepted.filter((k) => k.kind === kind);
        if (!group.length) return null;
        return (
          <section key={kind}>
            <h3>{KIND_LABELS[kind]}</h3>
            {group.map((k) => (
              <Entry key={k.id} entry={k} canEdit={canEdit} onChange={reload} />
            ))}
          </section>
        );
      })}

      {archived.length > 0 && (
        <section>
          <button className="link" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Hide" : "Show"} {archived.length} archived
          </button>
          {showArchived && archived.map((k) => <Entry key={k.id} entry={k} canEdit={canEdit} onChange={reload} />)}
        </section>
      )}
    </div>
  );
}

function Entry({ entry, canEdit, onChange }: { entry: KnowledgeDto; canEdit: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<Error>();
  const setStatus = (status: KnowledgeStatus) =>
    api.updateKnowledge(entry.id, { status }).then(onChange, (e: Error) => setError(e));

  if (editing) return <KnowledgeForm entry={entry} projectId={entry.projectId} onDone={() => (setEditing(false), onChange())} />;
  return (
    <div className={`card knowledge-entry status-${entry.status}`}>
      <div className="card-head">
        <strong>{entry.title}</strong>
        {entry.status !== "accepted" && <Pill tone={entry.status === "proposed" ? "attention" : "neutral"}>{entry.status}</Pill>}
        {entry.status === "proposed" && <span className="muted small">{KIND_LABELS[entry.kind]}</span>}
      </div>
      <p className="prose">{entry.body}</p>
      <div className="muted small knowledge-meta">
        {entry.sourceTaskId ? (
          <>
            from <a href={href.task(entry.sourceTaskId)}>{entry.sourceTaskKey}</a> ({entry.sourceAgent})
          </>
        ) : (
          <>written by {entry.createdBy ?? "someone"}</>
        )}
        {" · "}updated {timeAgo(entry.updatedAt)}
        {entry.decidedBy && entry.status !== "proposed" ? ` · ${entry.status} by ${entry.decidedBy}` : ""}
        {entry.supersededBy ? " · superseded" : ""}
        {canEdit && (
          <span className="knowledge-actions">
            {entry.status !== "accepted" && (
              <button className="link" onClick={() => setStatus("accepted")}>
                accept
              </button>
            )}
            {entry.status !== "archived" && (
              <button className="link" onClick={() => setStatus("archived")}>
                archive
              </button>
            )}
            <button className="link" onClick={() => setEditing(true)}>
              edit
            </button>
          </span>
        )}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function KnowledgeForm({ projectId, entry, onDone }: { projectId: string; entry?: KnowledgeDto; onDone: () => void }) {
  const [kind, setKind] = useState<KnowledgeKind>(entry?.kind ?? "architecture");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (entry) await api.updateKnowledge(entry.id, { kind, title, body });
      else await api.createKnowledge(projectId, { kind, title, body });
      onDone();
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };

  return (
    <form className="card knowledge-form" onSubmit={submit}>
      <div className="plan-row">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
            {KNOWLEDGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </label>
      </div>
      <label>
        Fact
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000} required />
      </label>
      <ErrorBox error={error} />
      <div className="actions left">
        <button className="primary" disabled={busy || !title.trim() || !body.trim()}>
          {entry ? "Save" : "Add"}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
