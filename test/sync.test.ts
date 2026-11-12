import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Guild } from "discord.js";
import type { ShardRpc } from "../src/cluster/shard-rpc";
import type { SyncNotice } from "../src/cluster/sync-feed";
import type { Database } from "../src/db";
import { EventRepository } from "../src/db/repos/events";
import { GuildRepository } from "../src/db/repos/guilds";
import { SyncRepository } from "../src/db/repos/sync";
import type { NewScheduledEvent } from "../src/db/schema";
import { describeLink, parseEventReference } from "../src/discord/commands/sync-command";
import { SyncService, type GuildLocator } from "../src/sync/sync-service";
import { createTestDatabase } from "./helpers/db";
import { silentLogger } from "./helpers/logger";

const A = "1030185189265133677"; // source
const B = "1030185189269328000"; // target
const BOT = "1259866759914192987";
const USER = "200000000000000001";
const now = new Date("2026-06-01T12:00:00Z");
const at = (mins: number) => new Date(now.getTime() + mins * 60_000);

let db: Database;
let close: () => Promise<void>;
let events: EventRepository;
let sync: SyncRepository;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  events = new EventRepository(db);
  sync = new SyncRepository(db);
  const guilds = new GuildRepository(db);
  await guilds.ensure(A, "Source Guild", 5);
  await guilds.ensure(B, "Target Guild", 5);
});
afterEach(() => close());

let seq = 0;
let discordIds = 0;
function ev(guildId: string, startsInMinutes: number, over: Partial<NewScheduledEvent> = {}): NewScheduledEvent {
  const id = String(1_300_000_000_000_000_000n + BigInt(++seq));
  return {
    id,
    guildId,
    name: `Event ${id.slice(-3)}`,
    description: "Bring snacks",
    url: `https://discord.com/events/${guildId}/${id}`,
    creatorId: USER,
    startsAt: at(startsInMinutes),
    status: "scheduled",
    createdAt: at(-60),
    ...over,
  };
}

/** A fake Discord guild whose scheduledEvents API records calls and, like the gateway, mirrors creates into the DB. */
function fakeGuild(id: string, name: string) {
  const calls: { op: string; id?: string; name?: string; description?: string; location?: string }[] = [];
  const gone = new Set<string>();
  const guild = {
    id,
    name,
    scheduledEvents: {
      create: async (o: { name: string; description: string; scheduledStartTime: Date; scheduledEndTime: Date; entityMetadata: { location: string } }) => {
        const newId = String(1_400_000_000_000_000_000n + BigInt(++discordIds)); // Discord ids are globally unique
        calls.push({ op: "create", id: newId, name: o.name, description: o.description, location: o.entityMetadata.location });
        await events.upsert({
          id: newId, guildId: id, name: o.name, description: o.description, creatorId: BOT,
          url: `https://discord.com/events/${id}/${newId}`, startsAt: o.scheduledStartTime, endsAt: o.scheduledEndTime,
          status: "scheduled", createdAt: now,
        });
        return { id: newId };
      },
      edit: async (eventId: string, o: { name: string }) => {
        if (gone.has(eventId)) throw Object.assign(new Error("Unknown"), { code: 10070 });
        calls.push({ op: "edit", id: eventId, name: o.name });
      },
      delete: async (eventId: string) => {
        if (gone.has(eventId)) throw Object.assign(new Error("Unknown"), { code: 10070 });
        gone.add(eventId);
        calls.push({ op: "delete", id: eventId });
      },
    },
  };
  return { guild: guild as unknown as Guild, calls, gone };
}

function makeService(guildMap: Map<string, Guild>) {
  const published: SyncNotice[] = [];
  const shards: GuildLocator = {
    shardCount: 2,
    guild: (id) => guildMap.get(id) ?? null,
    ownedShardIds: () => [0, 1],
    readyShardIds: () => [0, 1],
  };
  const rpc = { handle: () => {}, request: async () => ({}) } as unknown as ShardRpc;
  const service = new SyncService({
    sync, rpc, shards, botUserId: BOT, defaultDurationSeconds: 3600, logger: silentLogger,
    feed: { publish: async (n: SyncNotice) => void published.push(n) },
    now: () => now,
  });
  return { service, published };
}

const link = (targetGuildId: string, sourceGuildId: string, sourceEventId: string | null = null) =>
  sync.createLink({ targetGuildId, sourceGuildId, sourceEventId, createdBy: USER });

describe("SyncRepository", () => {
  test("links are unique even when sourceEventId is null", async () => {
    expect(await link(B, A)).toBeDefined();
    expect(await link(B, A)).toBeUndefined();
  });

  test("overlapping links cover each source event once; the target's own and bot-made events are excluded", async () => {
    const e1 = await events.upsert(ev(A, 60));
    await events.upsert(ev(A, 90, { creatorId: BOT })); // a mirror the bot made in A
    await events.upsert(ev(B, 60)); // B's own event
    await link(B, A);
    await link(B, A, e1.id);
    const covered = await sync.coveredSourceEvents(B, BOT);
    expect(covered.map((c) => c.event.id)).toEqual([e1.id]);
    expect(covered[0]!.sourceGuildName).toBe("Source Guild");
  });

  test("targetsForSource honours per-event links", async () => {
    const e1 = await events.upsert(ev(A, 60));
    const e2 = await events.upsert(ev(A, 60));
    await link(B, A, e1.id);
    expect(await sync.targetsForSource(A, [e1.id])).toEqual([B]);
    expect(await sync.targetsForSource(A, [e2.id])).toEqual([]);
    expect(await sync.targetsForSource(A)).toEqual([B]);
  });

  test("a mirror slot can be claimed exactly once", async () => {
    const e1 = await events.upsert(ev(A, 60));
    const claims = await Promise.all([1, 2, 3].map(() => sync.claimMirror(B, e1.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe("SyncService.reconcile", () => {
  test("mirrors upcoming source events as external events with a link back", async () => {
    const up = await events.upsert(ev(A, 60, { location: "Amsterdam" }));
    await events.upsert(ev(A, -10)); // already started
    await events.upsert(ev(A, 60, { status: "cancelled" }));
    await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[B, target.guild]]));

    expect(await service.reconcile(B)).toEqual({ created: 1, updated: 0, removed: 0 });
    const [call] = target.calls;
    expect(call).toMatchObject({ op: "create", name: up.name, location: "Amsterdam" });
    expect(call!.description).toContain(`Synced from **Source Guild** · ${up.url}`);

    expect(await service.reconcile(B)).toEqual({ created: 0, updated: 0, removed: 0 }); // idempotent
  });

  test("follows edits and cancellations at the source", async () => {
    const e1 = await events.upsert(ev(A, 60));
    await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[B, target.guild]]));
    await service.reconcile(B);
    const mirrorId = target.calls[0]!.id;

    await events.upsert({ ...ev(A, 60), id: e1.id, url: e1.url, name: "Renamed" });
    expect(await service.reconcile(B)).toMatchObject({ updated: 1 });
    expect(target.calls.at(-1)).toMatchObject({ op: "edit", id: mirrorId, name: "Renamed" });

    await events.markCancelled(e1.id);
    expect(await service.reconcile(B)).toMatchObject({ removed: 1 });
    expect(target.calls.at(-1)).toEqual({ op: "delete", id: mirrorId });
    expect(await sync.mirrors(B)).toHaveLength(0);
  });

  test("removing the link deletes its mirrors", async () => {
    await events.upsert(ev(A, 60));
    await events.upsert(ev(A, 120));
    const l = await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[B, target.guild]]));
    await service.reconcile(B);
    await sync.deleteLink(l!.id, B);
    expect(await service.reconcile(B)).toEqual({ created: 0, updated: 0, removed: 2 });
  });

  test("a mirror deleted by hand is not re-created", async () => {
    await events.upsert(ev(A, 60));
    await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[B, target.guild]]));
    await service.reconcile(B);
    await service.onEventDeleted(target.calls[0]!.id!); // gateway: someone deleted it in B
    expect(await service.reconcile(B)).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(target.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  test("two-way links (A→B and B→A) don't ping-pong mirrors", async () => {
    await events.upsert(ev(A, 60));
    await events.upsert(ev(B, 90));
    await link(B, A);
    await link(A, B);
    const a = fakeGuild(A, "Source Guild");
    const b = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[A, a.guild], [B, b.guild]]));
    for (let round = 0; round < 3; round++) {
      await service.reconcile(A);
      await service.reconcile(B);
    }
    expect(a.calls.filter((c) => c.op === "create")).toHaveLength(1); // only B's original event
    expect(b.calls.filter((c) => c.op === "create")).toHaveLength(1); // only A's original event
  });

  test("concurrent reconciles of one target create each mirror once", async () => {
    await events.upsert(ev(A, 60));
    await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const { service } = makeService(new Map([[B, target.guild]]));
    await Promise.all([service.reconcile(B), service.reconcile(B), service.reconcile(B)]);
    expect(target.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  test("a failed Discord create releases the claim so the next run retries", async () => {
    await events.upsert(ev(A, 60));
    await link(B, A);
    const target = fakeGuild(B, "Target Guild");
    const realCreate = target.guild.scheduledEvents.create;
    (target.guild.scheduledEvents as { create: unknown }).create = async () => {
      throw new Error("Discord is down");
    };
    const { service } = makeService(new Map([[B, target.guild]]));
    await expect(service.reconcile(B)).rejects.toThrow("Discord is down");
    (target.guild.scheduledEvents as { create: unknown }).create = realCreate;
    expect(await service.reconcile(B)).toMatchObject({ created: 1 });
  });

  test("source changes notify every target that covers them", async () => {
    const e1 = await events.upsert(ev(A, 60));
    await link(B, A, e1.id);
    const { service, published } = makeService(new Map());
    await service.notifySourceChanged(A, [e1.id], "event changed");
    expect(published).toEqual([{ targetGuildId: B, reason: "event changed" }]);
  });
});

describe("/sync input parsing", () => {
  test("Copy Event Link format, incl. other hosts and recurring occurrences", () => {
    const ev = "1300000000000000001";
    expect(parseEventReference(`https://discord.com/events/${A}/${ev}`)).toEqual({ kind: "event", guildId: A, eventId: ev });
    expect(parseEventReference(`  https://ptb.discord.com/events/${A}/${ev}?foo  `)).toMatchObject({ guildId: A, eventId: ev });
    expect(parseEventReference(`https://discordapp.com/events/${A}/${ev}/1700000000000000000`)).toMatchObject({ guildId: A, eventId: ev });
  });
  test("Share (invite) link format", () => {
    const ev = "1300000000000000001";
    expect(parseEventReference(`https://discord.gg/abcDEF12?event=${ev}`)).toEqual({ kind: "invite", code: "abcDEF12", eventId: ev });
    expect(parseEventReference(`https://discord.com/invite/my-vanity?utm=x&event=${ev}`)).toEqual({ kind: "invite", code: "my-vanity", eventId: ev });
  });
  test("rejects other input", () => {
    for (const bad of ["https://example.com/events/1/2", "https://discord.gg/abc", "1300000000000000001", "Test Event"]) {
      expect(parseEventReference(bad)).toBeNull();
    }
  });
  test("link descriptions", () => {
    expect(describeLink({ sourceGuildId: A, sourceGuildName: "TreeHouse", sourceEventId: null, sourceEventName: null })).toBe("All events from TreeHouse");
    expect(describeLink({ sourceGuildId: A, sourceGuildName: null, sourceEventId: "9", sourceEventName: "Meetup" })).toBe(`Meetup (from server ${A})`);
  });
});
