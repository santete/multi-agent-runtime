import type { ActorDto, AgentProfileDto, CostTier } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useLiveQuery } from "../lib/live.js";
import { timeAgo } from "../lib/model.js";
import { Empty, ErrorBox, Loading, Pill } from "./ui.js";

const canPublish = (actor: ActorDto) => actor.role === "senior" || actor.role === "owner";

/**
 * Agent marketplace (spec §53): reusable agent definitions — adapter,
 * skills, cost and standing instructions — published to the organization
 * (or to everyone), with how they did on its projects.
 */
export function MarketplacePage({ actor }: { actor: ActorDto }) {
  const [profiles, error, reload] = useLiveQuery(api.profiles, [], (e) => e.type.startsWith("AgentProfile") || e.type === "AgentFinished");
  const [publishing, setPublishing] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!profiles) return <Loading />;

  // Latest version first per name; older versions listed under it.
  const byName = new Map<string, AgentProfileDto[]>();
  for (const p of profiles) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p className="muted">
            Agent profiles your runners can build agents from (<span className="mono">"profile": "name"</span> in the runner config): what they
            are good at, what they cost, and the instructions every task they run gets.
          </p>
        </div>
        {canPublish(actor) && (
          <button className="primary" onClick={() => setPublishing((p) => !p)}>
            Publish a profile
          </button>
        )}
      </header>
      {publishing && <PublishForm actor={actor} onDone={() => (setPublishing(false), reload())} />}
      {byName.size === 0 && <Empty>No profiles yet.</Empty>}
      <div className="profile-grid">
        {[...byName.values()].map(([latest, ...older]) => (
          <div key={latest!.id} className={`card profile ${latest!.deprecated ? "deprecated" : ""}`}>
            <div className="card-head">
              <strong>{latest!.name}</strong>
              <span className="mono muted small">v{latest!.version}</span>
              <Pill tone={latest!.orgId ? "neutral" : "info"}>{latest!.orgId ? latest!.orgId : "public"}</Pill>
              {latest!.deprecated && <Pill tone="warning">deprecated</Pill>}
            </div>
            <p className="prose small">{latest!.description || <span className="muted">No description.</span>}</p>
            <div className="task-meta">
              <span className="chip">{latest!.adapter}</span>
              <span className="muted small">cost {latest!.cost}</span>
              {latest!.skills.map((s) => (
                <Pill key={s}>{s}</Pill>
              ))}
            </div>
            {latest!.instructions && (
              <details>
                <summary className="small">Standing instructions</summary>
                <pre className="code">{latest!.instructions}</pre>
              </details>
            )}
            <div className="muted small">
              {latest!.usage.executions
                ? `${latest!.usage.executions} runs here · ${latest!.usage.succeeded} succeeded · ${latest!.usage.failed} failed`
                : "not used here yet"}
              {" · "}published {timeAgo(latest!.createdAt)}
              {latest!.publishedBy ? ` by ${latest!.publishedBy}` : ""}
              {older.length ? ` · older: ${older.map((o) => `v${o.version}`).join(", ")}` : ""}
            </div>
            {canPublish(actor) && !latest!.deprecated && (latest!.orgId === actor.org || actor.org === "*") && (
              <div className="actions left">
                <button className="link" onClick={() => api.deprecateProfile(latest!.id).then(reload)}>
                  deprecate v{latest!.version}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PublishForm({ actor, onDone }: { actor: ActorDto; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", adapter: "claude-code", description: "", skills: "", cost: "medium" as CostTier, instructions: "", public: false });
  const [error, setError] = useState<Error>();
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.publishProfile({
        name: form.name,
        adapter: form.adapter,
        description: form.description,
        skills: form.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        cost: form.cost,
        instructions: form.instructions,
        ...(form.public && { public: true }),
      });
      onDone();
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <form className="card knowledge-form" onSubmit={submit}>
      <div className="plan-row">
        <label>
          Name
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="careful-coder" required />
        </label>
        <label>
          Adapter
          <select value={form.adapter} onChange={(e) => set({ adapter: e.target.value })}>
            {["claude-code", "codex", "antigravity", "qoder", "generic-cli"].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          Cost
          <select value={form.cost} onChange={(e) => set({ cost: e.target.value as CostTier })}>
            {["low", "medium", "high"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Description
        <input value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label>
        Skills (comma separated)
        <input value={form.skills} onChange={(e) => set({ skills: e.target.value })} placeholder="typescript, backend" />
      </label>
      <label>
        Standing instructions (every task the agent runs)
        <textarea rows={4} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
      </label>
      {actor.org === "*" && (
        <label className="check">
          <input type="checkbox" checked={form.public} onChange={(e) => set({ public: e.target.checked })} />
          Publish to every organization
        </label>
      )}
      <ErrorBox error={error} />
      <div className="actions left">
        <button className="primary" disabled={!form.name.trim()}>
          Publish
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
