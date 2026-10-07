import { describe, expect, it } from "vitest";
import { planWaves, proseBlocks } from "../src/lib/prose.js";

describe("proseBlocks", () => {
  it("keeps short text as one paragraph", () => {
    expect(proseBlocks("Do the thing.")).toEqual([{ kind: "p", text: "Do the thing." }]);
  });

  it("turns bullet lines into one list", () => {
    expect(proseBlocks("Intro\n- one\n- two\n3. three")).toEqual([
      { kind: "p", text: "Intro" },
      { kind: "ul", items: ["one", "two", "three"] },
    ]);
  });

  it("splits a (1) (2) (3) enumeration", () => {
    const blocks = proseBlocks("Decide: (1) scope. (2) stock model. (3) gateway.");
    expect(blocks).toEqual([
      { kind: "p", text: "Decide:" },
      { kind: "ul", items: ["scope.", "stock model.", "gateway."] },
    ]);
  });

  it("cuts a long paragraph at its sentence ends", () => {
    const sentence = "Đây là một câu khá dài để đủ vượt ngưỡng của đoạn văn.";
    const blocks = proseBlocks(`${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "ul" });
    expect((blocks[0] as { items: string[] }).items).toHaveLength(5);
  });
});

describe("planWaves", () => {
  it("numbers tasks by dependency depth and ignores unknown dependencies", () => {
    const waves = planWaves([
      { ref: "T1", dependsOn: [] },
      { ref: "T2", dependsOn: ["T1"] },
      { ref: "T3", dependsOn: ["T1", "T2"] },
      { ref: "T4", dependsOn: ["TBP-9"] },
    ]);
    expect([...waves]).toEqual([["T1", 1], ["T2", 2], ["T3", 3], ["T4", 1]]);
  });
});
