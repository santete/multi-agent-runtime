import { describe, expect, it } from "vitest";
import { containsSecret, evaluateToolCall, printsSecrets, redactDeep, redactor } from "../src/index.js";

const secrets = [
  { name: "NPM_TOKEN", value: "npm_abcdef123456" },
  { name: "PIN", value: "42" },
];

describe("secrets (spec §48)", () => {
  it("redacts values everywhere, but not values too short to tell apart", () => {
    const redact = redactor(secrets);
    expect(redact("token=npm_abcdef123456; again npm_abcdef123456; pin 42")).toBe("token=[secret NPM_TOKEN]; again [secret NPM_TOKEN]; pin 42");
    expect(redactDeep({ a: ["x npm_abcdef123456"], n: 1 }, redact)).toEqual({ a: ["x [secret NPM_TOKEN]"], n: 1 });
    expect(redactor([])("npm_abcdef123456")).toBe("npm_abcdef123456");
  });

  it("finds secret values in tool input", () => {
    expect(containsSecret({ file_path: ".npmrc", content: "//registry/:_authToken=npm_abcdef123456" }, secrets)).toBe(true);
    expect(containsSecret({ content: "use ${NPM_TOKEN}" }, secrets)).toBe(false);
  });

  it.each([
    ["echo $NPM_TOKEN", true],
    ["echo ${NPM_TOKEN} | base64", true],
    ['Write-Output "$env:NPM_TOKEN"', true],
    ["printenv NPM_TOKEN", true],
    ["printenv", true],
    ["env", true],
    ["env | grep NPM", true],
    ["Get-ChildItem env:", true],
    ["npm install --registry https://r.example.com", false],
    ["NODE_AUTH_TOKEN=$NPM_TOKEN npm publish --dry-run", false],
    ["env NODE_ENV=test node app.js", false],
    ["echo $HOME", false],
  ])("%s prints a secret: %s", (command, expected) => {
    expect(printsSecrets(command, ["NPM_TOKEN"])).toBe(expected);
  });

  it("makes printing a secret a HIGH-risk action that project rules cannot allow", () => {
    const ctx = {
      workspace: "C:\\ws",
      secretNames: ["NPM_TOKEN"],
      policy: {
        rules: [{ kind: "command" as const, pattern: ".", action: "allow" as const, reason: "anything" }],
        allowedHosts: [],
        approveMedium: false,
        approvers: { MEDIUM: "member" as const, HIGH: "senior" as const, CRITICAL: null },
      },
    };
    expect(evaluateToolCall({ tool: "Bash", input: { command: "echo $NPM_TOKEN" } }, ctx)).toMatchObject({ decision: "deny", risk: "HIGH", reason: "printing a secret" });
    expect(evaluateToolCall({ tool: "Bash", input: { command: "echo $NPM_TOKEN" } }, { workspace: "C:\\ws" })).toMatchObject({ decision: "allow" });
  });
});
