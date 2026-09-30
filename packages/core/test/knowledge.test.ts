import { describe, expect, it } from "vitest";
import { MAX_NOTES_PER_REPORT, sameKnowledge, toHandoff, toKnowledgeNotes } from "../src/index.js";

describe("knowledge notes", () => {
  it("keeps usable notes and defaults unknown kinds", () => {
    expect(
      toKnowledgeNotes([
        { kind: "business_rule", title: " Amounts are cents ", body: "All amounts are integer cents." },
        { kind: "gossip", title: "Odd kind", body: "kept as a decision" },
        { kind: "convention", title: "", body: "no title" },
        "nope",
      ]),
    ).toEqual([
      { kind: "business_rule", title: "Amounts are cents", body: "All amounts are integer cents." },
      { kind: "decision", title: "Odd kind", body: "kept as a decision" },
    ]);
    expect(toKnowledgeNotes("x")).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "decision", title: `t${i}`, body: "b" }));
    expect(toKnowledgeNotes(many)).toHaveLength(MAX_NOTES_PER_REPORT);
  });

  it("recognizes a restated fact", () => {
    expect(sameKnowledge({ kind: "convention", title: "Amounts are cents!" }, { kind: "convention", title: "amounts  are CENTS" })).toBe(true);
    expect(sameKnowledge({ kind: "convention", title: "Amounts are cents" }, { kind: "decision", title: "Amounts are cents" })).toBe(false);
  });

  it("is part of the handoff", () => {
    expect(toHandoff({ summary: "s", knowledge: [{ kind: "known_issue", title: "Flaky clock", body: "Tests use Date.now()." }] }).knowledge).toEqual([
      { kind: "known_issue", title: "Flaky clock", body: "Tests use Date.now()." },
    ]);
    expect(toHandoff("plain text").knowledge).toEqual([]);
  });
});
