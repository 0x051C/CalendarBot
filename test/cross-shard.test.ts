import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NatsConnection } from "@nats-io/transport-node";
import { ShardNotReadyError, ShardRpc } from "../src/cluster/shard-rpc";
import { SyncFeed, type SyncNotice } from "../src/cluster/sync-feed";
import { shardForGuild } from "../src/util/shard";
import { silentLogger } from "./helpers/logger";
import { connectTest, startNats, uniqueCluster } from "./helpers/nats";

const SHARD0_GUILD = "1030185189265133677";
const SHARD1_GUILD = "1030185189269328000";

let nats: Awaited<ReturnType<typeof startNats>>;
// Separate connections stand in for separate instances.
let ncA: NatsConnection;
let ncB: NatsConnection;

beforeAll(async () => {
  nats = await startNats();
  ncA = await connectTest(nats.url);
  ncB = await connectTest(nats.url);
});
afterAll(async () => {
  await Promise.all([ncA.drain(), ncB.drain()]);
  await nats.stop();
});

const waitFor = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

test("fixture guilds are on different shards", () => {
  expect(shardForGuild(SHARD0_GUILD, 2)).toBe(0);
  expect(shardForGuild(SHARD1_GUILD, 2)).toBe(1);
});

describe("ShardRpc", () => {
  test("requests reach whichever instance owns the guild's shard, and follow the lease", async () => {
    const cluster = uniqueCluster();
    const a = new ShardRpc({ nc: ncA, cluster, shardCount: 2, logger: silentLogger, timeoutMs: 500 });
    const b = new ShardRpc({ nc: ncB, cluster, shardCount: 2, logger: silentLogger, timeoutMs: 500 });
    a.handle("whoami", async (p) => ({ instance: "a", guild: p.guildId }));
    b.handle("whoami", async (p) => ({ instance: "b", guild: p.guildId }));

    a.serve(1); // instance A leases shard 1
    await ncA.flush();
    expect(await b.request(SHARD1_GUILD, "whoami", { guildId: SHARD1_GUILD })).toEqual({ instance: "a", guild: SHARD1_GUILD });

    a.unserve(1); // lease moves to B
    b.serve(1);
    await ncB.flush();
    expect(await a.request(SHARD1_GUILD, "whoami", { guildId: SHARD1_GUILD })).toEqual({ instance: "b", guild: SHARD1_GUILD });
    b.stop();
  });

  test("an unowned shard fails after retries; a not-ready shard is retried until ready", async () => {
    const cluster = uniqueCluster();
    const a = new ShardRpc({ nc: ncA, cluster, shardCount: 2, logger: silentLogger, timeoutMs: 300 });
    const b = new ShardRpc({ nc: ncB, cluster, shardCount: 2, logger: silentLogger, timeoutMs: 300 });
    await expect(a.request(SHARD0_GUILD, "x", {}, 2)).rejects.toThrow();

    let calls = 0;
    b.handle("x", async () => {
      if (++calls < 2) throw new ShardNotReadyError(0);
      return "ready";
    });
    b.serve(0);
    await ncB.flush();
    expect(await a.request<string>(SHARD0_GUILD, "x", {})).toBe("ready");
    expect(calls).toBe(2);
    b.stop();
  });
});

describe("SyncFeed", () => {
  test("notices are delivered only to the consumer of the target guild's shard", async () => {
    const cluster = uniqueCluster();
    const feed = await SyncFeed.open(ncA, { cluster, shardCount: 2, logger: silentLogger });
    const got0: SyncNotice[] = [];
    const got1: SyncNotice[] = [];
    await feed.consume(0, async (n) => void got0.push(n));
    await feed.consume(1, async (n) => void got1.push(n));
    await feed.publish({ targetGuildId: SHARD1_GUILD, reason: "test" });
    expect(await waitFor(() => got1.length === 1)).toBe(true);
    expect(got0).toHaveLength(0);
    await feed.stop();
  });

  test("notices published while a shard changes owner are picked up by the new owner", async () => {
    const cluster = uniqueCluster();
    const feedA = await SyncFeed.open(ncA, { cluster, shardCount: 2, logger: silentLogger });
    const feedB = await SyncFeed.open(ncB, { cluster, shardCount: 2, logger: silentLogger });
    const gotA: SyncNotice[] = [];
    await feedA.consume(0, async (n) => void gotA.push(n));
    await feedA.stopConsuming(0); // instance A loses shard 0

    await feedA.publish({ targetGuildId: SHARD0_GUILD, reason: "during failover" }); // nobody consuming

    const gotB: SyncNotice[] = [];
    await feedB.consume(0, async (n) => void gotB.push(n)); // instance B resumes the durable consumer
    expect(await waitFor(() => gotB.length === 1)).toBe(true);
    expect(gotB[0]!.reason).toBe("during failover");
    expect(gotA).toHaveLength(0);
    await Promise.all([feedA.stop(), feedB.stop()]);
  });

  test("a failing handler gets the notice redelivered", async () => {
    const cluster = uniqueCluster();
    const feed = await SyncFeed.open(ncA, { cluster, shardCount: 2, logger: silentLogger });
    let attempts = 0;
    await feed.consume(0, async () => {
      if (++attempts === 1) throw new Error("db hiccup");
    });
    await feed.publish({ targetGuildId: SHARD0_GUILD, reason: "retry me" });
    expect(await waitFor(() => attempts === 2, 8_000)).toBe(true);
    await feed.stop();
  }, 15_000);
});
