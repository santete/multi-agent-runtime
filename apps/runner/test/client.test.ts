import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneClient, ControlPlaneError } from "../src/client.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A server that answers with the given statuses in order (then 200). */
async function flaky(statuses: number[]): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  server = createServer((req, res) => {
    req.resume();
    const status = statuses[calls++] ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { status: "validating" } : { error: "x" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls: () => calls };
}

const fast = { attempts: 4, baseDelayMs: 5, maxDelayMs: 20 };
const done = { exitCode: 0, terminal: { kind: "failed" as const, reason: "x" } };

describe("ControlPlaneClient retries", () => {
  it("retries results of finished work through 5xx responses", async () => {
    const s = await flaky([503, 502]);
    const client = new ControlPlaneClient(s.url, "t", fast);
    expect(await client.complete("e1", done)).toEqual({ status: "validating" });
    expect(s.calls()).toBe(3);
  });

  it("retries through a control plane that is not listening yet", async () => {
    const s = await flaky([]);
    const port = new URL(s.url).port;
    await new Promise<void>((r) => server!.close(() => r()));
    const client = new ControlPlaneClient(s.url, "t", { attempts: 6, baseDelayMs: 50, maxDelayMs: 200 });
    const pending = client.complete("e1", done);
    // Comes back while the client is backing off.
    setTimeout(() => {
      server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "failed" }));
      });
      server.listen(Number(port), "127.0.0.1");
    }, 120);
    expect(await pending).toEqual({ status: "failed" });
  });

  it("does not retry 4xx responses or polling calls", async () => {
    const s = await flaky([409, 503]);
    const client = new ControlPlaneClient(s.url, "t", fast);
    await expect(client.complete("e1", done)).rejects.toMatchObject({ status: 409 });
    await expect(client.heartbeat("e1")).rejects.toBeInstanceOf(ControlPlaneError);
    expect(s.calls()).toBe(2);
  });

  it("gives up after the configured attempts", async () => {
    const s = await flaky([500, 500, 500, 500, 500]);
    const client = new ControlPlaneClient(s.url, "t", fast);
    await expect(client.complete("e1", done)).rejects.toMatchObject({ status: 500 });
    expect(s.calls()).toBe(4);
  });
});
