import type { ProjectDto, TaskDto } from "@mar/core";
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { PRIORITIES } from "../lib/model.js";
import { href } from "../lib/router.js";

const AUTO = "auto";

export function NewTaskDialog({ project, tasks, onClose }: { project: ProjectDto; tasks: TaskDto[]; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [requires, setRequires] = useState("");
  const [fallbackAgents, setFallbackAgents] = useState<string[]>([]);
  const [priority, setPriority] = useState(50);
  const [paths, setPaths] = useState("");
  const [criteria, setCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [inputs, setInputs] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Offer the agents registered runners provide (agent registry, spec §14).
    api.runners().then((runners) => {
      const ids = [...new Set(runners.flatMap((r) => r.agents.map((a) => a.id)))].sort();
      setAgents(ids);
      setAgent((current) => current || (ids.length ? AUTO : ""));
    });
  }, []);

  const candidates = tasks.filter((t) => t.state !== "CANCELLED");
  const toggle = (id: string) => setDependsOn((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const skills = requires
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const area = paths
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const lines = (text: string) =>
        text
          .split("\n")
          // One item per line; list markers ("- ", "1. ") are dropped.
          .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
          .filter(Boolean);
      const contract = {
        ...(lines(inputs).length && { inputs: lines(inputs) }),
        ...(lines(constraints).length && { constraints: lines(constraints) }),
        ...(expectedOutput.trim() && { expectedOutput: expectedOutput.trim() }),
        ...(lines(criteria).length && { acceptanceCriteria: lines(criteria) }),
      };
      const task = await api.createTask(project.id, {
        ...contract,
        title,
        objective,
        agent,
        ...(dependsOn.length && { dependsOn }),
        ...(priority !== 50 && { priority }),
        ...(area.length && { paths: area }),
        ...(agent === AUTO && skills.length && { requires: skills }),
        ...(agent !== AUTO && fallbackAgents.length && { fallbackAgents: fallbackAgents.filter((a) => a !== agent) }),
      });
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
              <option value={AUTO}>auto — scheduler picks by skills</option>
              {agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          ) : (
            <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="no runner registered yet" required />
          )}
        </label>
        {agent === AUTO ? (
          <label>
            Required skills (comma separated)
            <input value={requires} onChange={(e) => setRequires(e.target.value)} placeholder="e.g. typescript, backend" />
          </label>
        ) : (
          agents.length > 1 && (
            <fieldset>
              <legend>Fallback agents (take over if {agent} keeps failing or is unavailable)</legend>
              <div className="checks">
                {agents
                  .filter((a) => a !== agent)
                  .map((a) => (
                    <label key={a} className="check">
                      <input
                        type="checkbox"
                        checked={fallbackAgents.includes(a)}
                        onChange={() => setFallbackAgents((f) => (f.includes(a) ? f.filter((x) => x !== a) : [...f, a]))}
                      />
                      {a}
                    </label>
                  ))}
              </div>
            </fieldset>
          )
        )}
        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Acceptance criteria (one per line; a reviewer checks each before it can merge)
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={3}
            placeholder={"Refunding twice with the same request id refunds once\nREADME documents the new endpoint"}
          />
        </label>
        <details className="contract-more">
          <summary className="muted small">More of the contract: expected output, constraints, inputs</summary>
          <label>
            Expected output
            <input value={expectedOutput} onChange={(e) => setExpectedOutput(e.target.value)} placeholder="A POST /refunds endpoint with tests" />
          </label>
          <label>
            Constraints (one per line)
            <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={2} placeholder="Do not change the payment record shape" />
          </label>
          <label>
            Inputs (one per line)
            <textarea value={inputs} onChange={(e) => setInputs(e.target.value)} rows={2} placeholder="docs/refund-policy.md" />
          </label>
        </details>
        <label>
          Area (files or globs it changes, one per line; overlapping tasks run one after the other)
          <textarea value={paths} onChange={(e) => setPaths(e.target.value)} rows={2} placeholder={"src/payments/**\nREADME.md"} />
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
