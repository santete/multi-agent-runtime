import type { ActorDto, ApproverRole, PolicyRule, ProjectDto, ProjectPolicy } from "@mar/core";
import { useState } from "react";
import { api } from "../lib/api.js";
import { Empty, ErrorBox } from "./ui.js";

const KINDS: Record<PolicyRule["kind"], string> = {
  command: "command (regex)",
  write: "writes to (glob)",
  access: "reads or writes (glob)",
};
const ACTIONS: Record<PolicyRule["action"], string> = { allow: "allow", approve: "needs approval", deny: "deny" };
const ROLES: ApproverRole[] = ["member", "senior", "owner"];

/** The project's own tool-call rules on top of the built-in policy (spec §47). */
export function PolicyTab({ project, actor }: { project: ProjectDto; actor: ActorDto }) {
  const [policy, setPolicy] = useState<ProjectPolicy>(project.policy);
  const [hosts, setHosts] = useState(project.policy.allowedHosts.join("\n"));
  const [rule, setRule] = useState<PolicyRule>({ kind: "write", pattern: "", action: "approve", reason: "" });
  const [error, setError] = useState<Error>();
  const [saved, setSaved] = useState(false);
  const editable = actor.role === "owner";
  const change = (p: Partial<ProjectPolicy>) => {
    setPolicy((current) => ({ ...current, ...p }));
    setSaved(false);
  };

  const save = async () => {
    try {
      const allowedHosts = hosts
        .split(/[\n,]/)
        .map((h) => h.trim())
        .filter(Boolean);
      const updated = await api.setPolicy(project.id, { ...policy, allowedHosts });
      setPolicy(updated.policy);
      setError(undefined);
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <div className="policy">
      <p className="muted small">
        Every tool call an agent makes is checked by the built-in policy (secrets, git push, CI configuration, network…). These rules come on top of it:
        deny wins over approval over allow, and a rule never allows secrets, <span className="mono">.git</span>, files outside the worktree or
        CRITICAL actions.
      </p>

      <section className="card">
        <h3>Rules</h3>
        {policy.rules.length === 0 && <Empty>No project rules.</Empty>}
        {policy.rules.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>When the agent</th>
                <th>Pattern</th>
                <th>Then</th>
                <th>Why</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((r, i) => (
                <tr key={i}>
                  <td>{KINDS[r.kind]}</td>
                  <td className="mono">{r.pattern}</td>
                  <td>
                    <span className={`badge ${r.action === "deny" ? "tone-danger" : r.action === "approve" ? "tone-warning" : "tone-success"}`}>
                      {ACTIONS[r.action]}
                    </span>
                  </td>
                  <td>{r.reason}</td>
                  {editable && (
                    <td>
                      <button className="link" onClick={() => change({ rules: policy.rules.filter((_, j) => j !== i) })}>
                        remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editable && (
          <form
            className="policy-rule"
            onSubmit={(e) => {
              e.preventDefault();
              change({ rules: [...policy.rules, rule] });
              setRule({ ...rule, pattern: "", reason: "" });
            }}
          >
            <select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value as PolicyRule["kind"] })}>
              {Object.entries(KINDS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input
              className="mono"
              value={rule.pattern}
              onChange={(e) => setRule({ ...rule, pattern: e.target.value })}
              placeholder={rule.kind === "command" ? "\\bprisma\\s+migrate\\b" : "config/production/**"}
              required
            />
            <select value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value as PolicyRule["action"] })}>
              {Object.entries(ACTIONS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input value={rule.reason} onChange={(e) => setRule({ ...rule, reason: e.target.value })} placeholder="why" required />
            <button>Add rule</button>
          </form>
        )}
      </section>

      <section className="card policy-settings">
        <h3>Network and approvals</h3>
        <label>
          Hosts agents may reach without an approval (one per line, <span className="mono">*.example.com</span> for subdomains)
          <textarea rows={3} value={hosts} disabled={!editable} onChange={(e) => (setHosts(e.target.value), setSaved(false))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={policy.approveMedium} disabled={!editable} onChange={(e) => change({ approveMedium: e.target.checked })} />
          Installing dependencies (MEDIUM risk) needs an approval
        </label>
        <div className="plan-row">
          {(["MEDIUM", "HIGH", "CRITICAL"] as const).map((risk) => (
            <label key={risk}>
              {risk} approved by
              <select
                value={policy.approvers[risk] ?? ""}
                disabled={!editable}
                onChange={(e) =>
                  change({ approvers: { ...policy.approvers, [risk]: e.target.value === "" ? null : (e.target.value as ApproverRole) } })
                }
              >
                {risk === "CRITICAL" && <option value="">nobody (always denied)</option>}
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      {editable && (
        <div className="actions">
          <button className="primary" onClick={save}>
            Save policy
          </button>
          {saved && <span className="muted small">Saved.</span>}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
