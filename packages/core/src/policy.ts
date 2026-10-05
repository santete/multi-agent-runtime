import { matchesGlob } from "./paths.js";

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
  /** Tool name as the agent reports it (Bash, PowerShell, Write, run_command, write_to_file, shell_command, ...). */
  tool: string;
  input: unknown;
}

export interface PolicyContext {
  /** Absolute path of the task worktree. */
  workspace: string;
  /** The project's own rules on top of the built-in ones (spec §47). */
  policy?: ProjectPolicy | undefined;
  /** Environment variables holding secrets the agent has (spec §48): it may use them, not print them. */
  secretNames?: string[] | undefined;
}

/**
 * Whether a shell command would show secret values to the agent (and so to
 * its model and logs): dumping the environment, or echoing a secret variable.
 */
export function printsSecrets(command: string, names: string[]): boolean {
  if (/(^|[;&|]\s*)(printenv|env|set|export\s+-p)\s*($|[;&|>])|\b(get-childitem|gci|dir|ls)\s+env:|\[environment\]::getenvironmentvariables/im.test(command)) {
    return true;
  }
  const vars = names.map((n) => n.replace(/[^A-Z0-9_]/gi, "")).join("|");
  const reference = `(\\$\\{?(?:env:)?(?:${vars})\\b|%(?:${vars})%)`;
  return (
    new RegExp(`\\b(echo|printf|print|write-output|write-host|cat|type)\\b[^;&|]*${reference}`, "i").test(command) ||
    new RegExp(`\\bprintenv\\s+(${vars})\\b`, "i").test(command)
  );
}

export type ApproverRole = "member" | "senior" | "owner";

/**
 * A project rule (spec §47). `command` matches shell commands (a regular
 * expression); `write` matches files the agent writes and `access` files it
 * reads or writes (globs of the repository).
 */
export interface PolicyRule {
  kind: "command" | "write" | "access";
  pattern: string;
  /**
   * allow: lifts a built-in approval requirement (never for secrets, .git,
   * files outside the workspace or CRITICAL actions); approve: needs a
   * person (HIGH); deny: CRITICAL.
   */
  action: "allow" | "approve" | "deny";
  reason: string;
}

export interface ProjectPolicy {
  rules: PolicyRule[];
  /** Hosts network commands may reach without an approval (`*.example.com` for subdomains). */
  allowedHosts: string[];
  /** MEDIUM-risk actions (dependency installs) need an approval too. */
  approveMedium: boolean;
  /** Who may approve each risk level (spec §32); CRITICAL null = never, a hard deny. */
  approvers: { MEDIUM: ApproverRole; HIGH: ApproverRole; CRITICAL: ApproverRole | null };
}

export const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  rules: [],
  allowedHosts: [],
  approveMedium: false,
  approvers: { MEDIUM: "member", HIGH: "senior", CRITICAL: null },
};

/** Whether a denied verdict can be turned into an allow by a person under this policy. */
export function isApprovable(verdict: PolicyVerdict, policy: ProjectPolicy = DEFAULT_PROJECT_POLICY): boolean {
  if (verdict.decision !== "deny") return false;
  if (verdict.risk === "CRITICAL") return policy.approvers.CRITICAL !== null;
  return verdict.risk === "HIGH" || verdict.risk === "MEDIUM";
}

/** The role needed to approve an action of this risk. */
export function approverFor(risk: RiskLevel, policy: ProjectPolicy = DEFAULT_PROJECT_POLICY): ApproverRole | null {
  return risk === "LOW" ? "member" : policy.approvers[risk];
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  risk: RiskLevel;
  reason: string;
  /** Short human-readable description of the call for audit logs. */
  summary: string;
}

const SHELL_TOOLS = new Set(["bash", "powershell", "run_command", "shell", "exec_command", "shell_command"]);
const WRITE_TOOLS = new Set([
  "apply_patch",
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
  "write_file",
]);

/** CI configuration files: changing them changes what "passing" means. */
const CI_CONFIG_SOURCE =
  "(?:^|[\\\\/\\s\"'])(?:\\.github[\\\\/]workflows[\\\\/]|\\.gitlab-ci\\.ya?ml|jenkinsfile|azure-pipelines\\.ya?ml|\\.circleci[\\\\/]|bitbucket-pipelines\\.ya?ml|\\.buildkite[\\\\/])";
const CI_CONFIG_PATH = new RegExp(CI_CONFIG_SOURCE, "i");

/** Whether the path is CI configuration (a workflow, pipeline or Jenkinsfile). */
export function isCiConfigPath(path: string): boolean {
  return CI_CONFIG_PATH.test(` ${path}`);
}

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
  // An agent must fix its code, not the checks that judge it.
  {
    pattern: new RegExp(`^(?=.*(?:${CI_CONFIG_SOURCE}))(?=.*(?:>|\\bsed\\s+-i|\\b(?:set|add)-content\\b|\\bout-file\\b|\\btee\\b|\\b(?:mv|cp|rm)\\s|\\b(?:move|copy|remove|new)-item\\b|writefile))`, "is"),
    risk: "HIGH",
    reason: "changing CI configuration",
  },
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

/** Files named in a Codex `apply_patch` body ("*** Update File: path", ...). */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) =>
    (m[1] ?? m[2]!).trim(),
  );
}

function pathsOf(input: unknown): string[] {
  const i = asRecord(input);
  const direct = ["file_path", "path", "notebook_path", "TargetFile", "AbsolutePath", "target_file"]
    .map((k) => i[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  // Codex file changes: `paths` (runner events) or the patch text (hook payload).
  const listed = Array.isArray(i.paths) ? i.paths.filter((p): p is string => typeof p === "string") : [];
  const patch = [i.patch, i.input, i.command].find((v): v is string => typeof v === "string") ?? "";
  return [...direct, ...listed, ...patchPaths(patch)];
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

/**
 * Repository-relative paths a file-writing tool call writes inside the
 * workspace (path ownership, spec §27); empty for other tools.
 */
export function writtenPaths(call: ToolCall, workspace: string): string[] {
  return WRITE_TOOLS.has(call.tool.toLowerCase()) ? repositoryPaths(pathsOf(call.input), workspace) : [];
}

/** Repository-relative paths of files inside the workspace; others are left out. */
function repositoryPaths(paths: string[], workspace: string): string[] {
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  return paths.flatMap((p) => {
    const path = p.replace(/\\/g, "/");
    if (!/^([a-z]:\/|\/)/i.test(path)) return path.split("/").includes("..") ? [] : [path.replace(/^\.\//, "")];
    // Case-insensitive prefix (Windows), keeping the file's own case.
    return path.toLowerCase().startsWith(`${ws.toLowerCase()}/`) ? [path.slice(ws.length + 1)] : [];
  });
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
  const builtin = builtinVerdict(call, ctx);
  return ctx.policy ? applyProjectPolicy(call, ctx, builtin, ctx.policy) : builtin;
}

/**
 * The allow rule that lifts a denied call, if every denied part of it (each
 * command segment, each file) is covered by an allow rule: allowing `npm view`
 * must not also allow a `git reset --hard` in the same command.
 */
function liftingRule(call: ToolCall, ctx: PolicyContext, allows: PolicyRule[]): PolicyRule | undefined {
  if (!allows.length) return undefined;
  const tool = call.tool.toLowerCase();
  let used: PolicyRule | undefined;
  const covered = (rule: PolicyRule | undefined) => (rule ? ((used ??= rule), true) : false);
  if (SHELL_TOOLS.has(tool)) {
    const ok = segments(commandOf(call.input)).every(
      (s) =>
        builtinVerdict({ tool: call.tool, input: { command: s } }, ctx).decision === "allow" ||
        covered(allows.find((r) => r.kind === "command" && ruleRegExp(r.pattern)?.test(s))),
    );
    return ok ? used : undefined;
  }
  const writes = WRITE_TOOLS.has(tool);
  const ok = pathsOf(call.input).every(
    (p) =>
      builtinVerdict({ tool: call.tool, input: { file_path: p } }, ctx).decision === "allow" ||
      covered(
        allows.find(
          (r) => (r.kind === "access" || (r.kind === "write" && writes)) && repositoryPaths([p], ctx.workspace).some((f) => matchesGlob(f, r.pattern)),
        ),
      ),
  );
  return ok ? used : undefined;
}

/** Built-in verdicts a project rule may never lift. */
const UNLIFTABLE = new Set(["accessing secrets", "printing a secret", "writing inside .git", "writing outside the task workspace"]);

/** A rule's regular expression; an invalid one never matches (they are checked when saved). */
function ruleRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Spec §47: the project's rules on top of the built-in verdict. deny wins
 * over approve over allow; CRITICAL built-in verdicts are never lowered.
 */
function applyProjectPolicy(call: ToolCall, ctx: PolicyContext, builtin: PolicyVerdict, policy: ProjectPolicy): PolicyVerdict {
  const { workspace } = ctx;
  const shell = SHELL_TOOLS.has(call.tool.toLowerCase());
  const command = shell ? commandOf(call.input) : "";
  const accessed = shell ? [] : repositoryPaths(pathsOf(call.input), workspace);
  const written = writtenPaths(call, workspace);
  const matches = (r: PolicyRule) =>
    r.kind === "command"
      ? shell && (ruleRegExp(r.pattern)?.test(command) ?? false)
      : (r.kind === "write" ? written : accessed).some((f) => matchesGlob(f, r.pattern));
  const hit = (action: PolicyRule["action"]) => policy.rules.find((r) => r.action === action && matches(r));
  const { summary } = builtin;

  const deny = hit("deny");
  if (deny) return verdict("deny", "CRITICAL", `project policy: ${deny.reason}`, summary);
  if (builtin.risk === "CRITICAL") return builtin;
  const approve = hit("approve");
  if (approve) return verdict("deny", "HIGH", `project policy: ${approve.reason}`, summary);
  if (builtin.decision === "deny" && !UNLIFTABLE.has(builtin.reason)) {
    const allow = liftingRule(call, ctx, policy.rules.filter((r) => r.action === "allow"));
    if (allow) return verdict("allow", "MEDIUM", `${builtin.reason}, allowed by project policy: ${allow.reason}`, summary);
    if (builtin.reason === "network access" && reachesOnlyAllowedHosts(command, policy.allowedHosts)) {
      return verdict("allow", "MEDIUM", "network access to an allowed host", summary);
    }
  }
  if (builtin.decision === "allow" && builtin.risk === "MEDIUM" && policy.approveMedium) {
    return verdict("deny", "MEDIUM", `${builtin.reason} needs an approval in this project`, summary);
  }
  return builtin;
}

const hostAllowed = (host: string, allowed: string[]) =>
  allowed.some((a) => {
    const h = host.toLowerCase();
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) || h === p.slice(2) : h === p;
  });

/**
 * Whether every network command of a shell command only reaches allowed
 * hosts. Conservative: each network segment needs a URL, and every URL or
 * bare host name in it must be allowed (a file name like out.json counts as
 * a host unless it follows -o/--output).
 */
export function reachesOnlyAllowedHosts(command: string, allowed: string[]): boolean {
  if (!allowed.length) return false;
  const network = /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|scp|rsync|ssh|nc|ncat)\b/i;
  const parts = segments(command).filter((s) => network.test(s));
  if (!parts.length) return false;
  return parts.every((segment) => {
    if (!/\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b/i.test(segment)) return false; // ssh, scp, nc: always ask
    const tokens = segment.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
    let urls = 0;
    for (const [i, token] of tokens.entries()) {
      const url = /^https?:\/\/([^/:?#\s]+)/i.exec(token);
      if (url) {
        urls++;
        if (!hostAllowed(url[1]!, allowed)) return false;
        continue;
      }
      const bare = /^(?:[\w-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/\S*)?$/i.exec(token);
      if (bare && !/^(-o|--output|-OutFile)$/i.test(tokens[i - 1] ?? "") && !hostAllowed(bare[1]!, allowed)) return false;
    }
    return urls > 0;
  });
}

function builtinVerdict(call: ToolCall, ctx: PolicyContext): PolicyVerdict {
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
    if (ctx.secretNames?.length && printsSecrets(command, ctx.secretNames)) {
      return verdict("deny", "HIGH", "printing a secret", summary);
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
    if (paths.some(isCiConfigPath)) return verdict("deny", "HIGH", "changing CI configuration", summary);
    return verdict("allow", "LOW", "edit inside the task workspace", summary);
  }

  return verdict("allow", "LOW", "read-only or non-sensitive tool", summary);
}
