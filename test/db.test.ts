import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../src/db";
import { AlertRepository } from "../src/db/repos/alerts";
import { EventRepository } from "../src/db/repos/events";
import { GuildRepository } from "../src/db/repos/guilds";
import { shardForGuild } from "../src/util/shard";
import { createTestDatabase } from "./helpers/db";

// Two real-looking snowflakes that land on different shards when shardCount = 2.
const GUILD_A = "1030185189265133677";
const GUILD_B = "1030185189269328000";
const MIN = 60_000;

let db: Database;
let close: () => Promise<void>;
let guilds: GuildRepository;
let events: EventRepository;
let alerts: AlertRepository;

const now = new Date("2026-06-01T12:00:00Z");
const at = (mins: number) => new Date(now.getTime() + mins * MIN);

function event(id: string, guildId: string, startsInMinutes: number) {
  return {
    id,
    guildId,
    name: `Event ${id}`,
    url: `https://discord.com/events/${guildId}/${id}`,
    startsAt: at(startsInMinutes),
    status: "scheduled" as const,
    createdAt: at(-60),
  };
}

const due = (shardIds = [0, 1]) =>
  events.findDue({ now, shardCount: 2, shardIds, staleClaimBefore: at(-2), maxAttempts: 3 });
const claim = (eventId: string, startsAt: Date, instanceId: string, when = now) =>
  alerts.claim({ eventId, startsAt, instanceId, now: when, staleClaimBefore: new Date(when.getTime() - 2 * MIN), maxAttempts: 3 });

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  guilds = new GuildRepository(db);
  events = new EventRepository(db);
  alerts = new AlertRepository(db);
  await guilds.ensure(GUILD_A, "Guild A", 5);
  await guilds.ensure(GUILD_B, "Guild B", 5);
});
afterEach(() => close());

test("fixture guilds sit on different shards", () => {
  expect(shardForGuild(GUILD_A, 2)).not.toBe(shardForGuild(GUILD_B, 2));
});

describe("EventRepository.upsert", () => {
  test("bumps sequence only when visible fields change", async () => {
    const e = event("1", GUILD_A, 30);
    expect((await events.upsert(e)).sequence).toBe(0);
    expect((await events.upsert(e)).sequence).toBe(0);
    expect((await events.upsert({ ...e, name: "Renamed" })).sequence).toBe(1);
    expect((await events.upsert({ ...e, name: "Renamed", startsAt: at(45) })).sequence).toBe(2);
  });

  test("cancelMissing cancels events Discord no longer reports", async () => {
    await events.upsert(event("1", GUILD_A, 30));
    await events.upsert(event("2", GUILD_A, 30));
    const cancelled = await events.cancelMissing(GUILD_A, ["1"]);
    expect(cancelled.map((e) => e.id)).toEqual(["2"]);
    expect((await events.get("2"))?.status).toBe("cancelled");
    expect((await events.get("2"))?.sequence).toBe(1);
    expect(await events.markCancelled("2")).toBeUndefined(); // idempotent
  });
});

describe("EventRepository.findDue", () => {
  test("returns events inside their guild's lead window that have not started", async () => {
    await events.upsert(event("soon", GUILD_A, 3)); // inside 5-minute window
    await events.upsert(event("later", GUILD_A, 30)); // window not open yet
    await events.upsert(event("past", GUILD_A, -1)); // already started
    expect((await due()).map((r) => r.event.id)).toEqual(["soon"]);
  });

  test("honours per-guild lead time", async () => {
    await events.upsert(event("later", GUILD_A, 30));
    await guilds.setLeadMinutes(GUILD_A, 60);
    expect((await due()).map((r) => r.event.id)).toEqual(["later"]);
  });

  test("only returns guilds on the requested shards", async () => {
    await events.upsert(event("a", GUILD_A, 3));
    await events.upsert(event("b", GUILD_B, 3));
    const shardA = shardForGuild(GUILD_A, 2);
    expect((await due([shardA])).map((r) => r.event.id)).toEqual(["a"]);
  });
});

describe("AlertRepository.claim", () => {
  test("exactly one of many concurrent claimers wins", async () => {
    const e = await events.upsert(event("1", GUILD_A, 3));
    const results = await Promise.all(
      ["i1", "i2", "i3", "i4"].map((id) => claim(e.id, e.startsAt, id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await due()).toHaveLength(0);
  });

  test("sent alerts are never claimed again", async () => {
    const e = await events.upsert(event("1", GUILD_A, 3));
    expect(await claim(e.id, e.startsAt, "i1")).toBeDefined();
    await alerts.markSent(e.id, e.startsAt, "chan", "msg", now);
    expect(await claim(e.id, e.startsAt, "i2", at(10))).toBeUndefined();
  });

  test("failed alerts are retried up to maxAttempts", async () => {
    const e = await events.upsert(event("1", GUILD_A, 3));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const row = await claim(e.id, e.startsAt, "i1");
      expect(row?.attempts).toBe(attempt);
      await alerts.markFailed(e.id, e.startsAt, "boom");
    }
    expect(await claim(e.id, e.startsAt, "i1")).toBeUndefined();
    expect(await due()).toHaveLength(0);
  });

  test("a stale pending claim from a crashed instance can be taken over", async () => {
    const e = await events.upsert(event("1", GUILD_A, 3));
    expect(await claim(e.id, e.startsAt, "crashed")).toBeDefined();
    expect(await claim(e.id, e.startsAt, "other", at(1))).toBeUndefined(); // still fresh
    expect((await claim(e.id, e.startsAt, "other", at(2.5)))?.claimedBy).toBe("other");
  });

  test("rescheduling an event produces a new alert", async () => {
    const e = await events.upsert(event("1", GUILD_A, 3));
    await claim(e.id, e.startsAt, "i1");
    await alerts.markSent(e.id, e.startsAt, "chan", "msg", now);
    await events.upsert({ ...event("1", GUILD_A, 4) });
    expect((await due()).map((r) => r.event.id)).toEqual(["1"]);
  });
});
