import { useState } from "react";
import { api } from "../lib/api.js";
import { href } from "../lib/router.js";

/** "owner/repo" or a full URL; GitHub is assumed for the short form. */
function toRepoUrl(text: string): string {
  const t = text.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(t) ? `https://github.com/${t.replace(/\.git$/, "")}.git` : t;
}

/** Key suggested from the name: its first letters, uppercase. */
function suggestKey(name: string): string {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 4);
  return /^[A-Z]/.test(key) ? key.slice(0, 16) : "";
}

/** Validation steps, one per line: "name: command" or just a command. */
function parseSteps(text: string): Array<{ name: string; command: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^([\w.-]{1,40}):\s+(.+)$/.exec(line);
      return m ? { name: m[1]!, command: m[2]! } : { name: i === 0 ? "test" : `step-${i + 1}`, command: line };
    });
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [validation, setValidation] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const steps = parseSteps(validation);
      const project = await api.createProject({
        key,
        name: name.trim(),
        repoUrl: toRepoUrl(repo),
        defaultBranch: branch.trim() || "main",
        ...(steps.length && { validation: steps }),
      });
      onClose();
      window.location.hash = href.project(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New project</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyEdited) setKey(suggestKey(e.target.value));
            }}
            autoFocus
            required
          />
        </label>
        <label>
          Key <span className="muted small">— prefix of task keys (PAY-1): 2–16 uppercase letters or digits, starting with a letter</span>
          <input
            value={key}
            onChange={(e) => {
              setKey(e.target.value.toUpperCase());
              setKeyEdited(true);
            }}
            pattern="[A-Z][A-Z0-9]{1,15}"
            required
          />
        </label>
        <label>
          Repository <span className="muted small">— owner/repo on GitHub, or a clone URL (GitLab too)</span>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="santete/mar-sandbox" required />
        </label>
        <label>
          Default branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
        </label>
        <label>
          Validation <span className="muted small">— commands that must pass after an agent's work, one per line ("test: npm test" or just "npm test")</span>
          <textarea value={validation} onChange={(e) => setValidation(e.target.value)} rows={3} placeholder={"test: npm test\nlint: npm run lint"} />
        </label>
        <p className="muted small">
          Runners clone the repository with their machine's git credentials. Review, CI, budget, planning and policy are set on the
          project page afterwards.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
