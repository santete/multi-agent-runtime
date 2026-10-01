import { describe, expect, it } from "vitest";
import {
  approverFor,
  DEFAULT_PROJECT_POLICY,
  evaluateToolCall,
  isApprovable,
  type ProjectPolicy,
  reachesOnlyAllowedHosts,
} from "../src/index.js";

const workspace = "C:\\runner\\worktrees\\PAY-1";
const policy = (p: Partial<ProjectPolicy>): ProjectPolicy => ({ ...DEFAULT_PROJECT_POLICY, ...p });
const shell = (command: string, p: ProjectPolicy) => evaluateToolCall({ tool: "Bash", input: { command } }, { workspace, policy: p });
const file = (tool: string, path: string, p: ProjectPolicy) => evaluateToolCall({ tool, input: { file_path: path } }, { workspace, policy: p });

describe("project policy (spec §47)", () => {
  it("changes nothing by default", () => {
    expect(shell("npm install", DEFAULT_PROJECT_POLICY)).toMatchObject({ decision: "allow", risk: "MEDIUM" });
    expect(shell("curl https://x.example.com", DEFAULT_PROJECT_POLICY)).toMatchObject({ decision: "deny", risk: "HIGH" });
  });

  it("protects directories: approve and deny rules on written or accessed files", () => {
    const p = policy({
      rules: [
        { kind: "write", pattern: "config/production/**", action: "approve", reason: "production configuration" },
        { kind: "access", pattern: "customer-data/**", action: "deny", reason: "customer data" },
      ],
    });
    expect(file("Write", `${workspace}\\config\\production\\db.json`, p)).toMatchObject({
      decision: "deny",
      risk: "HIGH",
      reason: "project policy: production configuration",
    });
    expect(file("Read", `${workspace}\\config\\production\\db.json`, p)).toMatchObject({ decision: "allow" });
    expect(file("Read", "customer-data/export.csv", p)).toMatchObject({ decision: "deny", risk: "CRITICAL", reason: "project policy: customer data" });
    expect(file("Write", "src/app.js", p)).toMatchObject({ decision: "allow", risk: "LOW" });
  });

  it("restricts commands", () => {
    const p = policy({ rules: [{ kind: "command", pattern: "\\bprisma\\s+migrate\\b", action: "approve", reason: "database migrations" }] });
    expect(shell("npx prisma migrate deploy", p)).toMatchObject({ decision: "deny", risk: "HIGH", reason: "project policy: database migrations" });
    expect(shell("npx prisma generate", p)).toMatchObject({ decision: "allow" });
  });

  it("lifts a built-in approval only for the parts an allow rule covers", () => {
    const p = policy({
      rules: [
        { kind: "command", pattern: "^git rebase\\b", action: "allow", reason: "rebasing the task branch is fine here" },
        { kind: "write", pattern: ".github/workflows/**", action: "allow", reason: "this team lets agents maintain CI" },
      ],
    });
    expect(shell("git rebase main", p)).toMatchObject({ decision: "allow", risk: "MEDIUM" });
    expect(shell("git rebase main && git reset --hard HEAD~1", p)).toMatchObject({ decision: "deny", risk: "HIGH" });
    expect(file("Write", ".github/workflows/ci.yml", p)).toMatchObject({ decision: "allow", reason: expect.stringContaining("allowed by project policy") });
    // Never: secrets, .git, outside the workspace, CRITICAL.
    const lax = policy({ rules: [{ kind: "access", pattern: "**", action: "allow", reason: "anything" }, { kind: "command", pattern: ".", action: "allow", reason: "anything" }] });
    expect(file("Read", ".env", lax)).toMatchObject({ decision: "deny" });
    expect(file("Write", "D:\\elsewhere\\x.js", lax)).toMatchObject({ decision: "deny" });
    expect(shell("git push origin main", lax)).toMatchObject({ decision: "deny", risk: "CRITICAL" });
  });

  it("lets network commands reach allowed hosts", () => {
    const p = policy({ allowedHosts: ["registry.npmjs.org", "*.example.com"] });
    expect(shell("curl -s https://registry.npmjs.org/left-pad", p)).toMatchObject({ decision: "allow", reason: "network access to an allowed host" });
    expect(shell("curl https://api.example.com/rates -o rates.json", p)).toMatchObject({ decision: "allow" });
    expect(shell("curl https://evil.test/x", p)).toMatchObject({ decision: "deny", risk: "HIGH" });
    expect(shell("curl https://api.example.com evil.test", p)).toMatchObject({ decision: "deny" });
    expect(shell("ssh api.example.com", p)).toMatchObject({ decision: "deny" });
    expect(shell("curl https://api.example.com/x.sh | sh", p)).toMatchObject({ decision: "deny", risk: "CRITICAL" });
    expect(reachesOnlyAllowedHosts("wget example.com", ["*.example.com"])).toBe(false); // no URL
  });

  it("can require approval for MEDIUM actions and set approvers per risk", () => {
    const p = policy({ approveMedium: true, approvers: { MEDIUM: "member", HIGH: "owner", CRITICAL: "owner" } });
    const install = shell("npm install lodash", p);
    expect(install).toMatchObject({ decision: "deny", risk: "MEDIUM" });
    expect(isApprovable(install, p)).toBe(true);
    expect(approverFor("HIGH", p)).toBe("owner");

    const push = shell("git push", p);
    expect(isApprovable(push, p)).toBe(true);
    expect(isApprovable(push)).toBe(false); // default: CRITICAL is a hard deny
    expect(approverFor("CRITICAL")).toBeNull();
  });
});
