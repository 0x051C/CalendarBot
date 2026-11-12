import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Guild } from "discord.js";
import { AlertScheduler } from "../src/alerts/alert-scheduler";
import type { AlertService } from "../src/alerts/alert-service";
import type { Database } from "../src/db";
import { AlertRepository } from "../src/db/repos/alerts";
import { EventRepository } from "../src/db/repos/events";
import { GuildRepository } from "../src/db/repos/guilds";
import type { ShardManager } from "../src/discord/shard-manager";
import { createMetrics } from "../src/metrics";
import { createTestDatabase } from "./helpers/db";
import { silentLogger } from "./helpers/logger";

const GUILD = "1030185189265133677";
const now = new Date("2026-06-01T12:00:00Z");
let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  await new GuildRepository(db).ensure(GUILD, "TreeHouse", 5);
  const events = new EventRepository(db);
  for (const [id, mins] of [["1300000000000000001", 2], ["1300000000000000002", 4], ["1300000000000000003", 60]] as const) {
    await events.upsert({
      id, guildId: GUILD, name: id, url: "https://x", status: "scheduled",
      startsAt: new Date(now.getTime() + mins * 60_000), createdAt: now,
    });
  }
});
afterEach(() => close());

function makeScheduler(instanceId: string, sent: string[], fail = false) {
  const shards = { readyShardIds: () => [0], shardCount: 1, guild: () => ({ id: GUILD }) as unknown as Guild } as unknown as ShardManager;
  const alertService = {
    deliver: async (due: { event: { id: string } }) => {
      if (fail) throw new Error("discord down");
      sent.push(`${instanceId}:${due.event.id}`);
      return { channelId: "c", messageId: `m-${due.event.id}` };
    },
  } as unknown as AlertService;
  return new AlertScheduler({
    events: new EventRepository(db), alerts: new AlertRepository(db), alertService, shards,
    instanceId, intervalMs: 1_000, logger: silentLogger, metrics: createMetrics(), now: () => now,
  });
}

test("two instances racing on the same shard send each due alert exactly once", async () => {
  const sent: string[] = [];
  const a = makeScheduler("a", sent);
  const b = makeScheduler("b", sent);
  await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
  const ids = sent.map((s) => s.split(":")[1]).sort();
  expect(ids).toEqual(["1300000000000000001", "1300000000000000002"]); // the 60-min event isn't due
  await Promise.all([a.tick(), b.tick()]);
  expect(sent).toHaveLength(2);
});

test("failed deliveries are retried on later ticks, then given up", async () => {
  const sent: string[] = [];
  const flaky = makeScheduler("a", sent, true);
  for (let i = 0; i < 5; i++) await flaky.tick();
  const ok = makeScheduler("b", sent);
  await ok.tick();
  expect(sent).toEqual([]); // 3 failed attempts exhausted the retries
});
