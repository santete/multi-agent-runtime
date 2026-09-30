import type { ProjectDto, TaskDto } from "@mar/core";
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { href } from "../lib/router.js";

export function NewTaskDialog({ project, tasks, onClose }: { project: ProjectDto; tasks: TaskDto[]; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Offer the agents registered runners provide (agent registry, spec §14).
    api.runners().then((runners) => {
      const ids = [...new Set(runners.flatMap((r) => r.agents.map((a) => a.id)))].sort();
      setAgents(ids);
      setAgent((current) => current || ids[0] || "");
    });
  }, []);

  const candidates = tasks.filter((t) => t.state !== "CANCELLED");
  const toggle = (id: string) => setDependsOn((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const task = await api.createTask(project.id, { title, objective, agent, ...(dependsOn.length && { dependsOn }) });
      onClose();
      window.location.hash = href.task(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New task in {project.key}</h2>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
        </label>
        <label>
          Objective
          <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={6} required />
        </label>
        <label>
          Agent
          {agents.length ? (
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          ) : (
            <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="no runner registered yet" required />
          )}
        </label>
        {candidates.length > 0 && (
          <fieldset>
            <legend>Depends on (starts after these are merged)</legend>
            <div className="checks">
              {candidates.map((t) => (
                <label key={t.id} className="check">
                  <input type="checkbox" checked={dependsOn.includes(t.id)} onChange={() => toggle(t.id)} />
                  <span className="mono">{t.key}</span> {t.title}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !title || !objective || !agent}>
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}
