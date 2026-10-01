import { describe, expect, it } from "vitest";
import { areasOverlap, globsOverlap, matchesGlob, normalizePath } from "../src/index.js";

describe("path ownership", () => {
  it("normalizes paths", () => {
    expect(normalizePath(".\\src\\payments.js")).toBe("src/payments.js");
    expect(normalizePath("/src//a.js")).toBe("src/a.js");
  });

  it.each([
    ["src/payments.js", "src/payments.js", true],
    ["src/payments/refund.js", "src/payments/**", true],
    ["src/payments/deep/x.js", "src/payments/**", true],
    ["src/payments/refund.js", "src/payments", true],
    ["src/paymentsX.js", "src/payments", false],
    ["src/a.test.js", "src/*.test.js", true],
    ["src/sub/a.test.js", "src/*.test.js", false],
    ["test/refund.test.js", "**/*.test.js", true],
    ["README.md", "src/**", false],
  ])("%s matches %s: %s", (file, glob, expected) => {
    expect(matchesGlob(file, glob)).toBe(expected);
  });

  it.each([
    ["src/payments/**", "src/payments/refund.js", true],
    ["src/**", "src/payments/**", true],
    ["src/payments/**", "src/customers/**", false],
    ["README.md", "README.md", true],
    ["README.md", "src/**", false],
    ["src/export.js", "src/payments.js", false],
  ])("%s overlaps %s: %s", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  it("finds the overlapping pair between two areas", () => {
    expect(areasOverlap(["src/export.js", "README.md"], ["src/payments.js", "README.md"])).toEqual(["README.md", "README.md"]);
    expect(areasOverlap(["src/export.js"], ["src/payments.js"])).toBeNull();
    expect(areasOverlap([], ["src/**"])).toBeNull();
  });
});
