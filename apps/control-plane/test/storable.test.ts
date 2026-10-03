import { describe, expect, it } from "vitest";
import { createPgliteDb, migrate } from "../src/db.js";
import { storable } from "../src/storable.js";

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

describe("storable", () => {
  it("drops raw NUL characters and JSON-escaped ones", () => {
    expect(storable(`a${NUL}b`)).toBe("ab");
    // What WSL prints when it is not set up: UTF-16 text read as UTF-8.
    expect(storable(JSON.stringify({ text: `A${NUL} ${NUL}c${NUL}` }))).toBe('{"text":"A c"}');
  });

  it("keeps an escaped backslash followed by u0000, which is plain text", () => {
    const text = JSON.stringify({ path: `C:${BACKSLASH}u0000` });
    expect(storable(text)).toBe(text);
    expect(JSON.parse(storable(text) as string).path).toBe(`C:${BACKSLASH}u0000`);
  });

  it("leaves other values alone", () => {
    expect(storable(42)).toBe(42);
    expect(storable(null)).toBe(null);
    expect(storable("plain")).toBe("plain");
  });

  it("lets an event with NUL characters be stored", async () => {
    const db = await createPgliteDb();
    await migrate(db);
    await db.query("insert into events (id, type, payload) values ($1, $2, $3)", [
      "00000000-0000-0000-0000-000000000001",
      "AgentEvent",
      JSON.stringify({ kind: "message", text: `A${NUL} c` }),
    ]);
    const [row] = await db.query("select payload from events where type = 'AgentEvent'");
    expect(row!.payload).toEqual({ kind: "message", text: "A c" });
    await db.close();
  });
});
