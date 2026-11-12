import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { buildCalendar } from "../src/calendar/ics";
import { loadConfig } from "../src/config";
import type { ScheduledEvent } from "../src/db/schema";
import { attendance, buildAlertMessage, buildEmbed, mentionList, type AlertView } from "../src/discord/alert-message";
import { chooseAlertChannel, type ChannelCandidate } from "../src/discord/channel-resolver";
import { formatMinutes } from "../src/discord/commands/alert-command";
import { customId, parseCustomId } from "../src/discord/custom-ids";
import { shardForGuild } from "../src/util/shard";

const EVENT_ID = "1300000000000000001";

describe("custom ids", () => {
  test("round-trip", () => {
    expect(parseCustomId(customId.rsvp("going", EVENT_ID))).toEqual({ kind: "rsvp", status: "going", eventId: EVENT_ID });
    expect(parseCustomId(customId.rsvp("declined", EVENT_ID))).toEqual({ kind: "rsvp", status: "declined", eventId: EVENT_ID });
    expect(parseCustomId(customId.cancelEvent(EVENT_ID))).toEqual({ kind: "cancel-event", eventId: EVENT_ID });
  });
  test("buttons on alerts posted by v0 keep working", () => {
    expect(parseCustomId(`will_show${EVENT_ID}`)).toEqual({ kind: "rsvp", status: "going", eventId: EVENT_ID });
    expect(parseCustomId(`no_show${EVENT_ID}`)).toEqual({ kind: "rsvp", status: "declined", eventId: EVENT_ID });
  });
  test("rejects junk", () => {
    for (const id of ["", "rsvp:maybe:1", "rsvp:going:abc", "event:delete:" + EVENT_ID, "will_showundefined"]) {
      expect(parseCustomId(id)).toBeNull();
    }
  });
});

describe("shardForGuild", () => {
  test("matches Discord's (id >> 22) % n formula", () => {
    expect(shardForGuild("1030185189265133677", 1)).toBe(0);
    expect(shardForGuild("1030185189265133677", 4)).toBe(Number((1030185189265133677n >> 22n) % 4n));
  });
});

const view = (over: Partial<AlertView> = {}): AlertView => ({
  event: {
    id: EVENT_ID,
    guildId: "1",
    name: "Raid night",
    description: "Bring snacks",
    url: "https://discord.com/events/1/" + EVENT_ID,
    startsAt: new Date("2026-06-01T20:00:00Z"),
    channelId: "42",
    status: "scheduled",
  },
  interestedUserIds: ["a", "b"],
  rsvps: [],
  ...over,
});

describe("alert message", () => {
  test("interested users count as going unless they declined", () => {
    const a = attendance(view({ rsvps: [{ userId: "b", status: "declined" }, { userId: "c", status: "going" }] }));
    expect(a.going.sort()).toEqual(["a", "c"]);
    expect(a.declined).toEqual(["b"]);
  });

  test("only going users are pinged", () => {
    const msg = buildAlertMessage(view({ rsvps: [{ userId: "b", status: "declined" }] }), { embeds: true });
    expect(msg.content).toContain("<@a>");
    expect(msg.content).not.toContain("<@b>");
    expect(msg.allowedMentions.users).toEqual(["a"]);
  });

  test("degrades to text with a link when embeds are not allowed", () => {
    const msg = buildAlertMessage(view(), { embeds: false });
    expect(msg.embeds).toHaveLength(0);
    expect(msg.content).toContain(view().event.url);
  });

  test("cancelled events lose their buttons", () => {
    const v = view({ event: { ...view().event, status: "cancelled" } });
    expect(buildAlertMessage(v, { embeds: true }).components).toHaveLength(0);
    expect(buildEmbed(v).title).toStartWith("❌ Cancelled");
    const done = view({ event: { ...view().event, status: "completed" } });
    expect(buildAlertMessage(done, { embeds: true }).components).toHaveLength(0);
  });

  test("mention lists respect Discord's length limits", () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(1e17 + i));
    const list = mentionList(ids, 1024);
    expect(list.length).toBeLessThanOrEqual(1024);
    expect(list).toMatch(/…and \d+ more$/);
    expect(mentionList([], 10)).toBe("—");
  });
});

describe("chooseAlertChannel", () => {
  const ch = (id: string, position: number, over: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
    id, position, type: ChannelType.GuildText, canView: true, canSend: true, canEmbed: true, ...over,
  });

  test("override wins when usable", () => {
    const r = chooseAlertChannel({ candidates: [ch("1", 0), ch("2", 1)], overrideId: "2", systemChannelId: "1" });
    expect(r.choice).toMatchObject({ channelId: "2", source: "override" });
    expect(r.overrideProblem).toBeNull();
  });

  test("falls back to the system channel when the override is gone or unusable", () => {
    expect(chooseAlertChannel({ candidates: [ch("1", 0)], overrideId: "9", systemChannelId: "1" })).toMatchObject({
      choice: { channelId: "1", source: "system" },
      overrideProblem: "missing",
    });
    expect(
      chooseAlertChannel({ candidates: [ch("1", 0), ch("2", 1, { canSend: false })], overrideId: "2", systemChannelId: "1" })
        .overrideProblem,
    ).toBe("no-permission");
  });

  test("otherwise picks the top-most writable text channel", () => {
    const r = chooseAlertChannel({
      candidates: [ch("low", 5), ch("hidden", 0, { canView: false }), ch("top", 1), ch("voice", 0, { type: ChannelType.GuildVoice })],
      overrideId: null,
      systemChannelId: null,
    });
    expect(r.choice?.channelId).toBe("top");
  });

  test("returns null when nothing is writable", () => {
    expect(chooseAlertChannel({ candidates: [ch("1", 0, { canSend: false })], overrideId: null, systemChannelId: null }).choice).toBeNull();
  });
});

describe("buildCalendar", () => {
  const base: ScheduledEvent = {
    id: EVENT_ID, guildId: "1", name: "Raid night", description: null, location: null,
    url: "https://discord.com/events/1/" + EVENT_ID, creatorId: null, channelId: null,
    startsAt: new Date("2026-06-01T20:00:00Z"), endsAt: null, status: "scheduled", sequence: 2,
    createdAt: new Date("2026-05-01T00:00:00Z"), updatedAt: new Date("2026-05-02T00:00:00Z"),
  };

  test("maps status and sequence, and defaults the end time", () => {
    const ics = buildCalendar({ id: "1", name: "TreeHouse" }, [base, { ...base, id: "2", status: "cancelled" }], { defaultDurationSeconds: 3600 });
    expect(ics).toContain("X-WR-CALNAME:TreeHouse events");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("DTEND:20260601T210000Z");
  });
});

describe("formatMinutes", () => {
  test("humanises lead times", () => {
    expect(formatMinutes(0)).toBe("at the start time");
    expect(formatMinutes(5)).toBe("5m");
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(1500)).toBe("1d 1h");
  });
});

describe("loadConfig", () => {
  const env = { DISCORD_TOKEN: "t", DATABASE_URL: "postgres://u:p@localhost/db" };
  test("applies defaults and legacy variable names", () => {
    const c = loadConfig({ ...env, ALERT_LEAD_TIME: "10", ICAL_EVENT_DURATION: "3600" });
    expect(c.defaultAlertLeadMinutes).toBe(10);
    expect(c.icalEventDurationSeconds).toBe(3600);
    expect(c.shardCount).toBe("auto");
    expect(c.registerCommands).toBe(true);
  });
  test("reports every invalid variable at once", () => {
    expect(() => loadConfig({ SHARD_COUNT: "0" })).toThrow(/DISCORD_TOKEN[\s\S]*DATABASE_URL[\s\S]*SHARD_COUNT/);
  });
});
