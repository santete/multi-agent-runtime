import { describe, expect, it } from "vitest";
import { failureFingerprint, isEnvironmentFailure, similarQuestion } from "../src/index.js";

const step = (outputTail: string, exitCode: number | null = 1) => ({ name: "test", passed: false, exitCode, outputTail });

describe("isEnvironmentFailure", () => {
  it("recognises what the Ticket Booking attempts actually failed on", () => {
    expect(isEnvironmentFailure(step("> jest\n'jest' is not recognized as an internal or external command"))).toBe(true);
    expect(isEnvironmentFailure(step("jest : The term 'jest' is not recognized as the name of a cmdlet, function"))).toBe(true);
    expect(isEnvironmentFailure(step("WARN Local package.json exists, but node_modules missing, did you mean to install?"))).toBe(true);
    expect(isEnvironmentFailure(step("connect EACCES 104.16.5.34:443"))).toBe(true);
    expect(isEnvironmentFailure(step("sh: 1: jest: not found"))).toBe(true);
    expect(isEnvironmentFailure(step("whatever", 127))).toBe(true);
  });

  it("leaves real test failures to the agent", () => {
    expect(isEnvironmentFailure(step("FAIL src/a.spec.ts\n  ● adds\n    expect(received).toBe(expected)"))).toBe(false);
    expect(isEnvironmentFailure({ passed: true, exitCode: 0, outputTail: "command not found" })).toBe(false);
  });
});

describe("failureFingerprint", () => {
  it("is the same for the same failure with different numbers and paths", () => {
    const a = failureFingerprint([{ name: "test", passed: false, outputTail: "ok\nError: expected 3 but got 4 in C:\\w\\TBP-4\\a.ts:10" }]);
    const b = failureFingerprint([{ name: "test", passed: false, outputTail: "ok\nError: expected 7 but got 9 in C:\\w\\TBP-7\\a.ts:55" }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^test: error/);
  });

  it("differs by step and is null when everything passed", () => {
    expect(failureFingerprint([{ name: "lint", passed: false, outputTail: "Error: x" }])).not.toBe(
      failureFingerprint([{ name: "test", passed: false, outputTail: "Error: x" }]),
    );
    expect(failureFingerprint([{ name: "test", passed: true, outputTail: "" }])).toBeNull();
  });
});

describe("similarQuestion", () => {
  it("matches the question Codex asked three times in different words", () => {
    expect(
      similarQuestion(
        "Bạn có thể cung cấp môi trường đã cài dependencies hoặc cho phép kết nối package registry để chạy lại validation không?",
        "Bạn có thể cung cấp worktree đã cài dependencies hoặc môi trường cho phép truy cập npm registry để chạy validation không?",
      ),
    ).toBe(true);
  });

  it("keeps different questions apart", () => {
    expect(similarQuestion("H1 có bật lưu CCCD cho tài khoản không?", "Who approves refunds over 500 EUR?")).toBe(false);
  });
});
