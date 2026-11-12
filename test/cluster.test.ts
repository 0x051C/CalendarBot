import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NatsConnection } from "@nats-io/transport-node";
import { NatsIdentifyThrottler } from "../src/cluster/identify-throttler";
import { agreeOnShardCount, openBuckets } from "../src/cluster/nats";
import { ShardCoordinator } from "../src/cluster/shard-coordinator";
import { silentLogger } from "./helpers/logger";
import { connectTest, startNats, uniqueCluster } from "./helpers/nats";

const TTL = 1_500;
let nats: Awaited<ReturnType<typeof startNats>>;
let nc: NatsConnection;

beforeAll(async () => {
  nats = await startNats();
  nc = await connectTest(nats.url);
});
afterAll(async () => {
  await nc.drain();
  await nats.stop();
});

async function cluster(shardCount: number, ttl = TTL) {
  const buckets = await openBuckets(nc, uniqueCluster(), ttl);
  const make = (instanceId: string) =>
    new ShardCoordinator({ ...buckets, instanceId, shardCount, leaseTtlMs: ttl, logger: silentLogger });
  return { buckets, make };
}

/** Every shard owned by exactly one coordinator. */
function partitioned(coords: ShardCoordinator[], shardCount: number) {
  const all = coords.flatMap((c) => c.ownedShards()).sort((a, b) => a - b);
  return all.length === shardCount && all.every((s, i) => s === i);
}

describe("ShardCoordinator", () => {
  test("a single instance claims every shard", async () => {
    const { make } = await cluster(4);
    const a = make("a");
    await a.tick();
    expect(a.ownedShards()).toEqual([0, 1, 2, 3]);
    await a.stop();
  });

  test("instances converge to an even, disjoint split", async () => {
    const { make } = await cluster(4);
    const coords = [make("a"), make("b")];
    coords.forEach((c) => c.start());
    const ok = await coords[0]!.settle(
      () => partitioned(coords, 4) && coords.every((c) => c.ownedShards().length === 2),
      10_000,
    );
    expect(ok).toBe(true);

    // A third instance joins: everyone must end up with floor(4/3)=1 or ceil=2 shards.
    const c = make("c");
    c.start();
    coords.push(c);
    const rebalanced = await c.settle(
      () => partitioned(coords, 4) && coords.every((x) => [1, 2].includes(x.ownedShards().length)),
      10_000,
    );
    expect(rebalanced).toBe(true);
    await Promise.all(coords.map((x) => x.stop()));
  }, 30_000);

  test("shards fail over when an instance dies without releasing", async () => {
    const { make } = await cluster(4);
    const a = make("a");
    const b = make("b");
    a.start();
    b.start();
    await a.settle(() => partitioned([a, b], 4) && a.ownedShards().length === 2, 10_000);

    const released: number[] = [];
    b.on("released", (s) => released.push(s));
    // Simulate a crash: stop ticking but keep the leases (no graceful release).
    (b as unknown as { running: boolean }).running = false;

    const tookOver = await a.settle(() => a.ownedShards().length === 4, TTL * 6);
    expect(tookOver).toBe(true);
    await a.stop();
  }, 30_000);

  test("graceful stop hands shards over immediately", async () => {
    const { make } = await cluster(2, 60_000); // TTL long enough that only release explains a fast handover
    const a = make("a");
    const b = make("b");
    await a.tick();
    expect(a.ownedShards()).toEqual([0, 1]);
    await a.stop();
    await b.tick();
    expect(b.ownedShards()).toEqual([0, 1]);
    await b.stop();
  });

  test("a coordinator that loses its lease emits 'lost' and stops owning it", async () => {
    const { buckets, make } = await cluster(1);
    const a = make("a");
    await a.tick();
    const reasons: string[] = [];
    a.on("released", (_s, reason) => reasons.push(reason));
    // Another writer steals the key (e.g. after a partition outlasted the TTL).
    await buckets.leases.put("shard.0", "intruder");
    await a.tick();
    expect(reasons).toEqual(["lost"]);
    expect(a.owns(0)).toBe(false);
    await a.stop();
  });
});

describe("agreeOnShardCount", () => {
  test("the first instance's value wins for everyone", async () => {
    const { buckets } = await cluster(1);
    const results = await Promise.all([
      agreeOnShardCount(buckets.config, async () => 3, silentLogger),
      agreeOnShardCount(buckets.config, async () => 7, silentLogger),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(await agreeOnShardCount(buckets.config, async () => 99, silentLogger)).toBe(results[0]!);
  });
});

describe("NatsIdentifyThrottler", () => {
  test("serialises identifies in the same rate-limit bucket across instances", async () => {
    const { buckets } = await cluster(1);
    const a = new NatsIdentifyThrottler(buckets.identify, 1, "a", 50);
    const b = new NatsIdentifyThrottler(buckets.identify, 1, "b", 50);
    const signal = new AbortController().signal;
    const t0 = Date.now();
    await a.waitForIdentify(0, signal);
    await b.waitForIdentify(1, signal); // same bucket (max_concurrency = 1) → must wait for the window
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
  }, 15_000);

  test("can be aborted while waiting", async () => {
    const { buckets } = await cluster(1);
    const t = new NatsIdentifyThrottler(buckets.identify, 1, "a", 50);
    await t.waitForIdentify(0, new AbortController().signal);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("shutdown")), 200);
    await expect(t.waitForIdentify(0, ac.signal)).rejects.toThrow("shutdown");
  });
});
