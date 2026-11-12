import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { connectNats, natsConnectionOptions, openBuckets } from "../src/cluster/nats";
import { ShardCoordinator } from "../src/cluster/shard-coordinator";
import { ShardRpc } from "../src/cluster/shard-rpc";
import { SyncFeed, type SyncNotice } from "../src/cluster/sync-feed";
import { startStatusService } from "../src/cluster/status-service";
import { loadConfig } from "../src/config";
import { silentLogger } from "./helpers/logger";
import { startNats } from "./helpers/nats";

// Same shape as deploy/setup-pi.sh, plus a second account to prove isolation.
const BOT = { user: "calendarbot", pass: "s3cret-bot" };
const OTHER = { user: "someone", pass: "s3cret-other" };
const CONFIG = `
accounts {
  CALENDARBOT { jetstream: { max_mem: 16MB, max_file: 64MB }, users: [ { user: ${BOT.user}, password: "${BOT.pass}" } ] }
  OTHER       { jetstream: enabled,                           users: [ { user: ${OTHER.user}, password: "${OTHER.pass}" } ] }
}`;

let nats: Awaited<ReturnType<typeof startNats>>;
beforeAll(async () => {
  nats = await startNats({ config: CONFIG, probe: BOT });
});
afterAll(() => nats.stop());

const asBot = (instanceId: string) =>
  connectNats({ url: nats.url, instanceId, auth: { kind: "userpass", user: BOT.user, pass: BOT.pass } }, silentLogger);

describe("NATS authentication", () => {
  test("anonymous clients and wrong passwords are rejected", async () => {
    await expect(connect({ servers: nats.url, reconnect: false })).rejects.toThrow(/authorization/i);
    await expect(connect({ servers: nats.url, reconnect: false, user: BOT.user, pass: "wrong" })).rejects.toThrow(/authorization/i);
  });

  test("everything the bot uses works inside its account: KV leases, JetStream queue, RPC, micro-service", async () => {
    const nc = await asBot("a");
    const buckets = await openBuckets(nc, "calendarbot", 2_000);

    const coord = new ShardCoordinator({ ...buckets, instanceId: "a", shardCount: 2, leaseTtlMs: 2_000, logger: silentLogger });
    await coord.tick();
    expect(coord.ownedShards()).toEqual([0, 1]);

    const feed = await SyncFeed.open(nc, { cluster: "calendarbot", shardCount: 2, logger: silentLogger });
    const got: SyncNotice[] = [];
    await feed.consume(0, async (n) => void got.push(n));
    await feed.publish({ targetGuildId: "1030185189265133677", reason: "auth test" });

    const rpc = new ShardRpc({ nc, cluster: "calendarbot", shardCount: 2, logger: silentLogger });
    rpc.handle("ping", async () => "pong");
    rpc.serve(1);
    const nc2 = await asBot("b");
    const rpc2 = new ShardRpc({ nc: nc2, cluster: "calendarbot", shardCount: 2, logger: silentLogger });
    expect(await rpc2.request<string>("1030185189269328000", "ping", {})).toBe("pong");

    const svc = await startStatusService({ nc, cluster: "calendarbot", version: "0.0.0-test", buckets, local: () => ({ instanceId: "a", shards: [] }) });
    const cluster = (await nc2.request("calendarbot.cluster", "", { timeout: 2_000 })).json<{ leases: Record<string, string> }>();
    expect(cluster.leases).toEqual({ "shard.0": "a", "shard.1": "a" });

    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);

    await Promise.all([svc.stop(), feed.stop(), coord.stop()]);
    rpc.stop();
    await Promise.all([nc.drain(), nc2.drain()]);
  });

  test("another account can't see or reach the bot's buckets and subjects", async () => {
    const bot = await asBot("a");
    await openBuckets(bot, "calendarbot", 2_000);
    const rpc = new ShardRpc({ nc: bot, cluster: "calendarbot", shardCount: 2, logger: silentLogger });
    rpc.handle("ping", async () => "pong");
    rpc.serve(0);

    const other = await connect({ servers: nats.url, ...OTHER });
    const buckets: string[] = [];
    for await (const s of new Kvm(other).list()) buckets.push(s.bucket);
    expect(buckets).toEqual([]);
    await expect(other.request("calendarbot.shard.0.rpc", JSON.stringify({ op: "ping", payload: {} }), { timeout: 500 })).rejects.toThrow(
      /no responders/i,
    );
    rpc.stop();
    await Promise.all([bot.drain(), other.drain()]);
  });
});

describe("NATS connection options", () => {
  const base = { url: "nats://a:4222, nats://b:4222", instanceId: "x" };
  test("maps each auth method", () => {
    expect(natsConnectionOptions(base)).not.toHaveProperty("user");
    expect(natsConnectionOptions({ ...base, auth: { kind: "userpass", user: "u", pass: "p" } })).toMatchObject({ user: "u", pass: "p" });
    expect(natsConnectionOptions({ ...base, auth: { kind: "token", token: "t" } })).toMatchObject({ token: "t" });
    expect(natsConnectionOptions(base).servers).toEqual(["nats://a:4222", "nats://b:4222"]);
  });
  test("TLS from a CA file or tls:// URLs", () => {
    expect(natsConnectionOptions({ ...base, tlsCa: "/ca.pem" }).tls).toEqual({ caFile: "/ca.pem" });
    expect(natsConnectionOptions({ url: "tls://nats:4222", instanceId: "x" }).tls).toEqual({});
    expect(natsConnectionOptions(base).tls).toBeUndefined();
  });
  test("config rejects ambiguous or half-set credentials", () => {
    const env = { DISCORD_TOKEN: "t", DATABASE_URL: "postgres://u:p@h/db" };
    expect(loadConfig({ ...env, NATS_USER: "u", NATS_PASSWORD: "p" }).natsAuth).toEqual({ kind: "userpass", user: "u", pass: "p" });
    expect(() => loadConfig({ ...env, NATS_USER: "u" })).toThrow(/NATS_PASSWORD/);
    expect(() => loadConfig({ ...env, NATS_USER: "u", NATS_PASSWORD: "p", NATS_TOKEN: "t" })).toThrow(/only one/);
    expect(loadConfig({ ...env, HTTP_HOST: "127.0.0.1" }).httpHost).toBe("127.0.0.1");
  });
});
