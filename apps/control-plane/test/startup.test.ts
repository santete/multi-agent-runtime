import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUsers } from "../src/auth.js";
import { explainStartupError, StartupError } from "../src/startup.js";

const owner = { name: "me", role: "owner", token: "0123456789abcdef0123" };

describe("users file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mar-users-"));

  it("resolves a relative path from where the command was run (pnpm's INIT_CWD)", () => {
    writeFileSync(join(dir, "users.json"), JSON.stringify([owner]));
    expect(loadUsers({ MAR_USERS_FILE: "./users.json", INIT_CWD: dir })).toEqual([expect.objectContaining(owner)]);
  });

  it("reads a file written with a byte order mark (Windows PowerShell)", () => {
    writeFileSync(join(dir, "bom.json"), String.fromCharCode(0xfeff) + JSON.stringify([owner]));
    expect(loadUsers({ MAR_USERS_FILE: join(dir, "bom.json") })).toEqual([expect.objectContaining(owner)]);
  });

  it("says where it looked and what the file should contain", () => {
    expect(() => loadUsers({ MAR_USERS_FILE: "./missing.json", INIT_CWD: dir })).toThrow(StartupError);
    expect(() => loadUsers({ MAR_USERS_FILE: "./missing.json", INIT_CWD: dir })).toThrow(
      new RegExp(`${join(dir, "missing.json").replace(/\\/g, "\\\\")} does not exist.*JSON array`),
    );
  });

  it("names the invalid field", () => {
    writeFileSync(join(dir, "short.json"), JSON.stringify([{ ...owner, token: "short" }]));
    expect(() => loadUsers({ MAR_USERS_FILE: join(dir, "short.json") })).toThrow(/0\.token: tokens must be at least 16 characters/);
    writeFileSync(join(dir, "broken.json"), "[{");
    expect(() => loadUsers({ MAR_USERS_FILE: join(dir, "broken.json") })).toThrow(/is not valid JSON/);
  });
});

describe("explainStartupError", () => {
  const context = { databaseUrl: "postgres://mar:mar@localhost:5432/mar", host: "127.0.0.1", port: 7700 };

  it("tells how to start Postgres when it cannot be reached", () => {
    // pg reports a refused connection as an AggregateError of per-address errors.
    const refused = Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })], ""), {});
    expect(explainStartupError(refused, context)).toBe(
      "Cannot connect to Postgres at localhost:5432/mar (ECONNREFUSED). Is it running? Start the bundled one with " +
        "`docker compose up -d` in the repository, or unset DATABASE_URL to use embedded PGlite.",
    );
    expect(explainStartupError(Object.assign(new Error("auth"), { code: "28P01" }), context)).toMatch(/rejected the user or password/);
  });

  it("explains a port that is taken", () => {
    const inUse = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(explainStartupError(inUse, { host: "127.0.0.1", port: 7700 })).toMatch(/Port 7700 on 127\.0\.0\.1 is already in use/);
  });

  it("passes its own errors through and keeps others readable", () => {
    expect(explainStartupError(new StartupError("set MAR_USERS_FILE"), context)).toBe("set MAR_USERS_FILE");
    expect(explainStartupError(new Error("boom"), context)).toBe("Control plane failed to start: boom");
  });
});
