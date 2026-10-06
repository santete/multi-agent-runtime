import type { ActorDto, BrokenMainPolicy, ProjectDto, RoutingPolicy, ValidationStep } from "@mar/core";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.js";
import { ErrorBox } from "./ui.js";

/** Project settings that used to need the API: everything a project owner configures. */
export function SettingsTab({ project, actor, onSaved }: { project: ProjectDto; actor: ActorDto; onSaved: (p: ProjectDto) => void }) {
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    api.runners().then((runners) => setAgents([...new Set(runners.flatMap((r) => r.agents.map((a) => a.id)))].sort()));
  }, []);
  const owner = actor.role === "owner";
  const props = { project, owner, onSaved };
  return (
    <div className="settings">
      {!owner && <p className="muted">Only an owner can change these settings.</p>}
      <ValidationSettings {...props} />
      <ReviewSettings {...props} agents={agents} />
      <MergeSettings {...props} />
      <AgentSettings {...props} agents={agents} />
      <GeneralSettings {...props} />
      <SandboxSettings {...props} />
    </div>
  );
}

type SectionProps = { project: ProjectDto; owner: boolean; onSaved: (p: ProjectDto) => void };

/** One settings card: its own form, Save button and saved/error feedback. */
function SettingsCard({
  title,
  help,
  owner,
  save,
  children,
}: {
  title: string;
  help: ReactNode;
  owner: boolean;
  save: () => Promise<void>;
  children: ReactNode;
}) {
  const [error, setError] = useState<Error>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await save();
      setError(undefined);
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card settings-card" onSubmit={submit} onChange={() => setSaved(false)}>
      <h3>{title}</h3>
      <p className="muted small">{help}</p>
      <fieldset disabled={!owner || busy}>{children}</fieldset>
      {owner && (
        <div className="actions left">
          <button className="primary" disabled={busy}>
            Save
          </button>
          {saved && <span className="saved small">Saved</span>}
        </div>
      )}
      <ErrorBox error={error} />
    </form>
  );
}

function ValidationSettings({ project, owner, onSaved }: SectionProps) {
  const [steps, setSteps] = useState<ValidationStep[]>(project.validation);
  const update = (i: number, patch: Partial<ValidationStep>) => setSteps((s) => s.map((step, j) => (j === i ? { ...step, ...patch } : step)));
  return (
    <SettingsCard
      title="Validation"
      owner={owner}
      help={
        <>
          Commands run in the task's worktree after the agent finishes, in order; all must pass before review. Without them the platform
          only has the agent's word that it works. Install dependencies first if the repository needs them (e.g.{" "}
          <span className="mono">pnpm install --frozen-lockfile</span>).
        </>
      }
      save={async () => onSaved(await api.setValidation(project.id, steps.filter((s) => s.name.trim() && s.command.trim())))}
    >
      {steps.length === 0 && <p className="warning small">No validation: delivered work is not checked.</p>}
      {steps.map((step, i) => (
        <div className="settings-row" key={i}>
          <input aria-label="Step name" value={step.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="test" required />
          <input
            aria-label="Command"
            className="mono grow"
            value={step.command}
            onChange={(e) => update(i, { command: e.target.value })}
            placeholder="npm test"
            required
          />
          <input
            aria-label="Timeout (seconds)"
            type="number"
            min="1"
            max="7200"
            value={step.timeoutSeconds ?? ""}
            onChange={(e) => {
              const { timeoutSeconds: _drop, ...rest } = step;
              setSteps((s) => s.map((x, j) => (j === i ? (e.target.value ? { ...rest, timeoutSeconds: Number(e.target.value) } : rest) : x)));
            }}
            placeholder="timeout s"
          />
          <button type="button" onClick={() => setSteps((s) => s.filter((_, j) => j !== i))} aria-label={`Remove ${step.name || "step"}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setSteps((s) => [...s, { name: s.length ? `step-${s.length + 1}` : "test", command: "" }])}>
        Add step
      </button>
    </SettingsCard>
  );
}

function ReviewSettings({ project, owner, onSaved, agents }: SectionProps & { agents: string[] }) {
  const [reviewers, setReviewers] = useState<string[]>(project.reviewAgents);
  const [autoApprove, setAutoApprove] = useState(project.autoApproveOnAgentReview);
  const offered = [...new Set([...agents, ...reviewers])].sort();
  return (
    <SettingsCard
      title="Review"
      owner={owner}
      help="Validated work goes to review. Pick agents to review it before you: the first checked agent that an online runner offers (never the task's own agent) reviews, the others take over if it is unavailable. One agent review per task; without reviewers, you review every task on its page."
      save={async () => onSaved(await api.setReview(project.id, { reviewAgents: reviewers, autoApproveOnAgentReview: reviewers.length > 0 && autoApprove }))}
    >
      {offered.length === 0 ? (
        <p className="muted small">No runner has registered agents yet.</p>
      ) : (
        <div className="checks">
          {offered.map((a) => (
            <label key={a} className="check">
              <input
                type="checkbox"
                checked={reviewers.includes(a)}
                onChange={() => setReviewers((r) => (r.includes(a) ? r.filter((x) => x !== a) : [...r, a]))}
              />
              {a}
            </label>
          ))}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={autoApprove} disabled={!reviewers.length} onChange={(e) => setAutoApprove(e.target.checked)} />
        Merge when the reviewing agent approves (no person in the loop)
      </label>
    </SettingsCard>
  );
}

function MergeSettings({ project, owner, onSaved }: SectionProps) {
  const [waitForChecks, setWait] = useState(project.waitForChecks);
  const [revalidate, setRevalidate] = useState(project.revalidateOnBaseChange);
  const [onBrokenMain, setOnBrokenMain] = useState<BrokenMainPolicy>(project.onBrokenMain);
  return (
    <SettingsCard
      title="Merging and CI"
      owner={owner}
      help="Approved tasks are merged one at a time through the merge queue."
      save={async () => {
        await api.setMergePolicy(project.id, { waitForChecks, revalidateOnBaseChange: revalidate });
        onSaved(await api.setSelfHealing(project.id, onBrokenMain));
      }}
    >
      <label className="check">
        <input type="checkbox" checked={waitForChecks} onChange={(e) => setWait(e.target.checked)} />
        Wait for the pull request's CI checks to pass before merging
      </label>
      <label className="check">
        <input type="checkbox" checked={revalidate} onChange={(e) => setRevalidate(e.target.checked)} />
        Validate again on the latest base branch when it moved since the task was validated
      </label>
      <label>
        When CI fails on the base branch after a merge
        <select className="inline-select" value={onBrokenMain} onChange={(e) => setOnBrokenMain(e.target.value as BrokenMainPolicy)}>
          <option value="notify">notify people</option>
          <option value="revert">revert the merge</option>
          <option value="fix">ask an agent to fix it</option>
        </select>
      </label>
    </SettingsCard>
  );
}

const ROUTING: Array<{ value: RoutingPolicy; label: string }> = [
  { value: "balanced", label: "balanced: reliability, then cost and load" },
  { value: "reliability", label: "reliability: the agent with the best results" },
  { value: "cost", label: "cost: the cheapest agent that can do it" },
  { value: "speed", label: "speed: the fastest agent" },
];

function AgentSettings({ project, owner, onSaved, agents }: SectionProps & { agents: string[] }) {
  const [routing, setRouting] = useState<RoutingPolicy>(project.routingPolicy);
  const [allowed, setAllowed] = useState<string[]>(project.allowedAgents);
  const offered = [...new Set([...agents, ...allowed])].sort();
  return (
    <SettingsCard
      title="Agents"
      owner={owner}
      help={
        <>
          Tasks with agent <span className="mono">auto</span> are routed by this policy among the allowed agents. Before agents have a
          history they count as equally reliable, so the cheapest wins: allow only the agents you trust with this project.
        </>
      }
      save={async () => {
        await api.setAllowedAgents(project.id, allowed);
        onSaved(await api.setRoutingPolicy(project.id, routing));
      }}
    >
      <label>
        Routing policy
        <select className="inline-select" value={routing} onChange={(e) => setRouting(e.target.value as RoutingPolicy)}>
          {ROUTING.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <p className="small">Allowed agents {allowed.length === 0 && <span className="muted">(none checked: any agent)</span>}</p>
      <div className="checks">
        {offered.map((a) => (
          <label key={a} className="check">
            <input type="checkbox" checked={allowed.includes(a)} onChange={() => setAllowed((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]))} />
            {a}
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}

function GeneralSettings({ project, owner, onSaved }: SectionProps) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch);
  const [maxParallel, setMaxParallel] = useState(project.maxParallel?.toString() ?? "");
  return (
    <SettingsCard
      title="General"
      owner={owner}
      help={
        <>
          Key <span className="mono">{project.key}</span> and repository <span className="mono">{project.repoUrl}</span> cannot change.
        </>
      }
      save={async () => onSaved(await api.setGeneral(project.id, { name, defaultBranch: branch, maxParallel: maxParallel ? Number(maxParallel) : null }))}
    >
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Base branch
        <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
      </label>
      <label>
        Tasks working at once
        <input type="number" min="1" max="100" value={maxParallel} onChange={(e) => setMaxParallel(e.target.value)} placeholder="unlimited" />
      </label>
    </SettingsCard>
  );
}

function SandboxSettings({ project, owner, onSaved }: SectionProps) {
  const s = project.validationSandbox;
  const [enabled, setEnabled] = useState(Boolean(s));
  const [image, setImage] = useState(s?.image ?? "node:22-alpine");
  const [network, setNetwork] = useState(s?.network ?? false);
  const [memory, setMemory] = useState(s?.memory ?? "");
  const [cpus, setCpus] = useState(s?.cpus?.toString() ?? "");
  return (
    <SettingsCard
      title="Validation sandbox"
      owner={owner}
      help="Run the validation commands in a container instead of on the runner machine (the runner needs Docker or Podman)."
      save={async () =>
        onSaved(
          await api.setValidationSandbox(
            project.id,
            enabled ? { image, network, ...(memory && { memory }), ...(cpus && { cpus: Number(cpus) }) } : null,
          ),
        )
      }
    >
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Validate in a container
      </label>
      {enabled && (
        <>
          <label>
            Image
            <input className="mono" value={image} onChange={(e) => setImage(e.target.value)} required />
          </label>
          <label className="check">
            <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />
            Network access (needed to install dependencies inside the container)
          </label>
          <div className="settings-row">
            <label>
              Memory
              <input value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="e.g. 2g" />
            </label>
            <label>
              CPUs
              <input type="number" min="0.5" step="0.5" value={cpus} onChange={(e) => setCpus(e.target.value)} />
            </label>
          </div>
        </>
      )}
    </SettingsCard>
  );
}
