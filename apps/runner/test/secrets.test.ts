import { describe, expect, it } from "vitest";
import { secretLeaks } from "../src/runner.js";

describe("secret scan of the changes (spec §48)", () => {
  it("names each secret written into the changes and the files it is in", () => {
    const diff = [
      "diff --git a/src/config.js b/src/config.js",
      "+const region = process.env.SANDBOX_REGION;",
      "diff --git a/test/config.test.js b/test/config.test.js",
      '+assert.equal(region(), "eu-west");',
      "diff --git a/.npmrc b/.npmrc",
      "+//registry/:_authToken=sbx_123456789",
      "",
    ].join("\n");
    expect(
      secretLeaks(diff, [
        { name: "SANDBOX_REGION", value: "eu-west" },
        { name: "NPM_TOKEN", value: "sbx_123456789" },
        { name: "UNUSED", value: "not-in-the-diff" },
      ]),
    ).toEqual([
      { name: "SANDBOX_REGION", files: ["test/config.test.js"] },
      { name: "NPM_TOKEN", files: [".npmrc"] },
    ]);
  });
});
