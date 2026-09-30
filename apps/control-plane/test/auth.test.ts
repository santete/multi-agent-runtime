import { describe, expect, it } from "vitest";
import { Authenticator, hasRole, loadUsers } from "../src/auth.js";

const users = [
  { name: "vy", role: "viewer" as const, token: "viewer-token-0000001" },
  { name: "sam", role: "senior" as const, token: "senior-token-0000001" },
  { name: "box", role: "runner" as const, token: "runner-token-0000001" },
];

describe("Authenticator", () => {
  it("resolves bearer tokens to actors", () => {
    const auth = new Authenticator(users);
    expect(auth.authenticate("Bearer senior-token-0000001")).toEqual({ name: "sam", role: "senior" });
    expect(auth.authenticate("Bearer nope")).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
    expect(auth.authenticate("senior-token-0000001")).toBeNull();
  });

  it("acts as the local owner in open mode", () => {
    expect(new Authenticator([]).authenticate(undefined)).toEqual({ name: "local", role: "owner" });
  });
});

describe("hasRole", () => {
  it("orders human roles and keeps runners separate", () => {
    const actor = (role: "viewer" | "member" | "senior" | "owner" | "runner") => ({ name: "x", role });
    expect(hasRole(actor("senior"), "member")).toBe(true);
    expect(hasRole(actor("member"), "senior")).toBe(false);
    expect(hasRole(actor("owner"), "runner")).toBe(true);
    expect(hasRole(actor("runner"), "runner")).toBe(true);
    expect(hasRole(actor("runner"), "viewer")).toBe(false);
    expect(hasRole(actor("senior"), "runner")).toBe(false);
  });
});

describe("loadUsers", () => {
  it("adds MAR_API_TOKEN as an owner and rejects short tokens", () => {
    expect(loadUsers({ MAR_API_TOKEN: "a-long-enough-token" })).toEqual([
      { name: "admin", role: "owner", token: "a-long-enough-token" },
    ]);
    expect(() => loadUsers({ MAR_API_TOKEN: "short" })).toThrow();
  });
});
