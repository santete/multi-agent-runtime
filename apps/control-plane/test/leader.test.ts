import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProjectDto } from "@mar/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Background, buildApp, createPgDb, type Db, migrate, Notifier, notifierOptionsFromEnv, Store } from "../src/index.js";

/**
 * Leader election between control plane instances (ADR-0033), against a real
 * Postgres in a container: advisory locks do not exist in PGlite.
 */

const IMAGE = "postgres:16-alpine";
const docker = (args: string[], timeout = 60_000) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout });

/**
 * Docker can actually start a container from the image. A daemon can be up and answer `image inspect` yet be
 * unable to start anything (seen live: containers stuck in "Created" while Docker Desktop's VM was wedged); the
 * suite then waited minutes and left containers behind.
 */
function dockerReady(): boolean {
  if (docker(["image", "inspect", IMAGE], 20_000).status !== 0) return false;
  const name = `mar-leader-probe-${process.pid}`;
  const ok = docker(["run", "--rm", "--name", name, IMAGE, "true"], 30_000).status === 0;
  if (!ok) docker(["rm", "-f", name], 20_000);
  return ok;
}

describe.skipIf(!dockerReady())("leader election on Postgres", () => {
  let container: string;
  let url: string;
  const dbs: Db[] = [];
  const open = () => {
    const db = createPgDb(url);
    dbs.push(db);
    return db;
  };
  /** Ends the connection holding the advisory lock, as if that instance's network dropped. */
  const cutLeaderConnection = async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted");
    await admin.end();
  };

  beforeAll(async () => {
    container = `mar-leader-${process.pid}`;
    const run = docker(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=mar", "-e", "POSTGRES_DB=mar", "-p", "127.0.0.1::5432", IMAGE]);
    if (run.status !== 0) throw new Error(`could not start postgres: ${run.stderr}`);
    const port = docker(["port", container, "5432"]).stdout.trim().split(":").pop();
    url = `postgres://postgres:mar@127.0.0.1:${port}/mar`;
    for (let i = 0; ; i++) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.end();
        break;
      } catch {
        await client.end().catch(() => undefined);
        if (i > 60) throw new Error("postgres did not start");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await migrate(open());
  }, 120_000);

  afterAll(async () => {
    for (const db of dbs) await db.close().catch(() => undefined);
    if (container) docker(["rm", "-f", container]);
  });

  it("applies migrations once when several instances start at the same time", async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("create database mar_fresh");
    await admin.end();
    const fresh = url.replace(/\/mar$/, "/mar_fresh");
    const instances = [createPgDb(fresh), createPgDb(fresh), createPgDb(fresh)];
    dbs.push(...instances);
    const results = await Promise.all(instances.map((db) => migrate(db)));
    const all = results.flat();
    expect(new Set(all).size).toBe(all.length); // nothing applied twice
    expect(all.length).toBeGreaterThan(20); // and everything applied by someone
    expect(await migrate(instances[0]!)).toEqual([]);
  }, 60_000);

  it("lets one instance hold the lock, and hands it over when released", async () => {
    const a = open().leaderLock("test-handover");
    const b = open().leaderLock("test-handover");
    expect(await a.hold()).toBe(true);
    expect(await b.hold()).toBe(false);
    expect(await a.hold()).toBe(true); // still held
    await a.release();
    expect(await b.hold()).toBe(true);
    expect(await a.hold()).toBe(false);
    await b.release();
  });

  it("moves the lead to another instance when the leader's connection dies", async () => {
    const a = open().leaderLock("test-failover");
    const b = open().leaderLock("test-failover");
    expect(await a.hold()).toBe(true);
    await cutLeaderConnection();
    expect(await b.hold()).toBe(true);
    expect(await a.hold()).toBe(false); // notices, and does not take it back
    expect(await a.hold()).toBe(false);
    await b.release();
  });

  it("runs the background work of two control planes once", async () => {
    let received: string[] = [];
    const hook: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        received.push(JSON.parse(body).text);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

    const instance = () => {
      const db = open();
      const store = new Store(db);
      const notifier = new Notifier(store, { ...notifierOptionsFromEnv({ MAR_NOTIFY_WEBHOOKS: hookUrl }, "http://mar.test"), retryDelaysMs: [10] });
      const calls = { mergeQueue: 0 };
      const merge = store.processMergeQueue.bind(store);
      store.processMergeQueue = async () => {
        calls.mergeQueue++;
        return merge();
      };
      return { store, calls, background: new Background({ store, notifier, leader: db.leaderLock("background") }) };
    };
    const a = instance();
    const b = instance();
    try {
      expect(await a.background.housekeeping()).toBe(true);
      expect(await b.background.housekeeping()).toBe(false);
      expect([a.background.isLeader, b.background.isLeader]).toEqual([true, false]);
      expect([a.calls.mergeQueue, b.calls.mergeQueue]).toEqual([1, 0]);
      await a.background.notify(); // the first poll starts at the end of the log

      // Something a person must hear about, created through either instance's API.
      const api = buildApp(b.store);
      const project = (await api.inject({ method: "POST", url: "/projects", payload: { key: "LDR", name: "p", repoUrl: "https://github.com/o/r.git" } })).json<ProjectDto>();
      await api.inject({ method: "POST", url: `/projects/${project.id}/tasks`, payload: { title: "Sign the DPA", objective: "o", agent: "human" } });
      await api.close();

      await Promise.all([a.background.notify(), b.background.notify(), a.background.notify(), b.background.notify()]);
      expect(received).toEqual([expect.stringContaining("Sign the DPA")]);

      // The leader goes away: the other instance takes over the background work and the notifications.
      await cutLeaderConnection();
      expect(await b.background.housekeeping()).toBe(true);
      expect(await a.background.housekeeping()).toBe(false);
      expect([a.background.isLeader, b.background.isLeader]).toEqual([false, true]);
      received = [];
      const api2 = buildApp(a.store);
      await api2.inject({ method: "POST", url: `/projects/${project.id}/tasks`, payload: { title: "Renew the cert", objective: "o", agent: "human" } });
      await api2.close();
      await Promise.all([a.background.notify(), b.background.notify()]);
      expect(received).toEqual([expect.stringContaining("Renew the cert")]);
    } finally {
      await a.background.stop();
      await b.background.stop();
      await new Promise((r) => hook.close(r));
    }
  }, 60_000);
});
