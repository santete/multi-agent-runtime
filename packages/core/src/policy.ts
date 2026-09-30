/**
 * Tool-call policy (spec §31-32, ADR-0004). Evaluated for every tool call an
 * agent makes, via the PreToolUse hook the runner injects.
 *
 * M2 has no approval gateway yet, so HIGH and CRITICAL calls are denied; a
 * denied call surfaces as a denied action and parks the task for a human.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PolicyDecision = "allow" | "deny";

export interface ToolCall {
  /** Tool name as the agent reports it (Bash, PowerShell, Write, run_command, write_to_file, ...). */
  tool: string;
  input: unknown;
}

export interface PolicyContext {
  /** Absolute path of the task worktree. */
  workspace: string;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  risk: RiskLevel;
  reason: string;
  /** Short human-readable description of the call for audit logs. */
  summary: string;
}

const SHELL_TOOLS = new Set(["bash", "powershell", "run_command", "shell", "exec_command"]);
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
]);

interface CommandRule {
  pattern: RegExp;
  risk: Extract<RiskLevel, "HIGH" | "CRITICAL">;
  reason: string;
}

/** Evaluated against each command segment; first match wins. */
const COMMAND_RULES: CommandRule[] = [
  { pattern: /\bgit\s+push\b/, risk: "CRITICAL", reason: "pushing is done by the platform, never by agents" },
  { pattern: /\bgit\s+remote\s+(add|set-url|remove|rm)\b/, risk: "CRITICAL", reason: "changing git remotes" },
  { pattern: /\bgit\s+(config\s+--global|credential)\b/, risk: "CRITICAL", reason: "changing global git config or credentials" },
  { pattern: /\bgh\s+(pr|release|repo|api|secret|auth)\b/, risk: "CRITICAL", reason: "GitHub operations are done by the platform" },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\btwine\s+upload\b/, risk: "CRITICAL", reason: "publishing artifacts" },
  { pattern: /\b(kubectl|helm)\s+(apply|delete|install|upgrade|rollout)\b|\bterraform\s+(apply|destroy)\b/, risk: "CRITICAL", reason: "infrastructure change" },
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|[a-z]:[\\/])(\s|$)/i, risk: "CRITICAL", reason: "recursive delete of a root or home directory" },
  { pattern: /\bremove-item\b.*-recurse.*\s([a-z]:\\?|~|\$env:userprofile)(\s|$)/i, risk: "CRITICAL", reason: "recursive delete of a root or home directory" },
  { pattern: /\b(mkfs|format-volume|diskpart|shutdown|reboot|stop-computer|restart-computer)\b/i, risk: "CRITICAL", reason: "system-level operation" },
  { pattern: /\bsudo\b|\brunas\b/, risk: "CRITICAL", reason: "privilege escalation" },
  { pattern: /(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|;&]*\|\s*(sh|bash|zsh|iex|invoke-expression|python|node)\b/i, risk: "CRITICAL", reason: "piping downloaded code into an interpreter" },
  { pattern: /(^|[\s"'=/\\])\.env(\.[\w-]+)?(\s|$|["'])|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|id_rsa|id_ed25519/i, risk: "HIGH", reason: "accessing secrets" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch|reflog\s+expire)\b/, risk: "HIGH", reason: "destructive git history/worktree operation" },
  { pattern: /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|scp|rsync|ssh|nc|ncat)\b/i, risk: "HIGH", reason: "network access" },
];

const MEDIUM_COMMANDS = /\b(npm|pnpm|yarn|pip|pip3|uv|poetry|cargo|go|dotnet|mvn|gradle)\s+(install|add|i|get|restore)\b/;

const SECRET_PATH = /(^|[\\/])\.env(\.[\w-]+)?$|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.gnupg[\\/]|id_rsa|id_ed25519/i;
const GIT_DIR = /(^|[\\/])\.git([\\/]|$)/;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function commandOf(input: unknown): string {
  const i = asRecord(input);
  const cmd = i.command ?? i.CommandLine ?? i.cmd ?? "";
  return Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
}

function pathsOf(input: unknown): string[] {
  const i = asRecord(input);
  return ["file_path", "path", "notebook_path", "TargetFile", "AbsolutePath", "target_file"]
    .map((k) => i[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True if `path` is inside `workspace` (relative paths are relative to the workspace). */
export function isInsideWorkspace(path: string, workspace: string): boolean {
  const isAbsolute = /^([a-z]:[\\/]|[\\/])/i.test(path);
  if (!isAbsolute) return !normalize(path).split("/").includes("..");
  const ws = normalize(workspace);
  const target = normalize(path);
  if (target.split("/").includes("..")) return false;
  return target === ws || target.startsWith(ws + "/");
}

function verdict(decision: PolicyDecision, risk: RiskLevel, reason: string, summary: string): PolicyVerdict {
  return { decision, risk, reason, summary };
}

/** Splits a shell command on separators so each segment is checked. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Identity of a call for human approvals: the same command approved once is
 * allowed again even if the agent switches shell tools (Bash vs PowerShell).
 */
export function approvalKey(call: ToolCall): string {
  const tool = call.tool.toLowerCase();
  if (SHELL_TOOLS.has(tool)) return `shell:${commandOf(call.input).trim()}`;
  const paths = pathsOf(call.input);
  return `${WRITE_TOOLS.has(tool) ? "write" : tool}:${paths.join(",")}`;
}

export function evaluateToolCall(call: ToolCall, ctx: PolicyContext): PolicyVerdict {
  const tool = call.tool.toLowerCase();

  if (SHELL_TOOLS.has(tool)) {
    const command = commandOf(call.input);
    const summary = `${call.tool}: ${command.slice(0, 200)}`;
    for (const rule of COMMAND_RULES) {
      // Check the whole command too, so pipes like `curl ... | sh` are seen together.
      if (rule.pattern.test(command) || segments(command).some((s) => rule.pattern.test(s))) {
        return verdict("deny", rule.risk, rule.reason, summary);
      }
    }
    if (MEDIUM_COMMANDS.test(command)) return verdict("allow", "MEDIUM", "dependency installation", summary);
    return verdict("allow", "LOW", "shell command inside the task workspace", summary);
  }

  const paths = pathsOf(call.input);
  const summary = `${call.tool}${paths.length ? `: ${paths.join(", ")}` : ""}`;

  if (paths.some((p) => SECRET_PATH.test(p))) return verdict("deny", "HIGH", "accessing secrets", summary);

  if (WRITE_TOOLS.has(tool)) {
    if (paths.some((p) => GIT_DIR.test(p))) return verdict("deny", "CRITICAL", "writing inside .git", summary);
    if (paths.some((p) => !isInsideWorkspace(p, ctx.workspace))) {
      return verdict("deny", "HIGH", "writing outside the task workspace", summary);
    }
    return verdict("allow", "LOW", "edit inside the task workspace", summary);
  }

  return verdict("allow", "LOW", "read-only or non-sensitive tool", summary);
}
