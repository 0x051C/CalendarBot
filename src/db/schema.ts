import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Per-server settings. Rows are created the first time a shard sees the guild. */
export const guilds = pgTable("guilds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  alertLeadMinutes: integer("alert_lead_minutes").notNull(),
  /** Channel override set via `/alert channel`; null = pick automatically. */
  alertChannelId: text("alert_channel_id"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type EventStatus = "scheduled" | "active" | "completed" | "cancelled";

/** Mirror of Discord scheduled events; Discord is the source of truth. */
export const scheduledEvents = pgTable(
  "scheduled_events",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    location: text("location"),
    url: text("url").notNull(),
    creatorId: text("creator_id"),
    channelId: text("channel_id"),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at"),
    status: text("status").$type<EventStatus>().notNull(),
    /** iCalendar SEQUENCE: bumped whenever a user-visible field changes. */
    sequence: integer("sequence").notNull().default(0),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("scheduled_events_guild_idx").on(t.guildId), index("scheduled_events_starts_idx").on(t.startsAt)],
);

export type RsvpStatus = "going" | "declined";

export const rsvps = pgTable(
  "rsvps",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => scheduledEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    status: text("status").$type<RsvpStatus>().notNull(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] })],
);

export type DeliveryStatus = "pending" | "sent" | "failed";

/**
 * One row per (event, start time) alert. The primary key is what makes
 * delivery exactly-once across instances: an instance must win the
 * INSERT ... ON CONFLICT claim before it is allowed to send. Rescheduling an
 * event to a new start time produces a new alert.
 */
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => scheduledEvents.id, { onDelete: "cascade" }),
    startsAt: tz("starts_at").notNull(),
    status: text("status").$type<DeliveryStatus>().notNull(),
    attempts: integer("attempts").notNull().default(1),
    claimedBy: text("claimed_by").notNull(),
    claimedAt: tz("claimed_at").notNull(),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    error: text("error"),
    sentAt: tz("sent_at"),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.startsAt] })],
);

/**
 * "Copy events from `sourceGuildId` (optionally just `sourceEventId`) into
 * `targetGuildId`". Created by `/sync` in the target server.
 */
export const syncLinks = pgTable(
  "sync_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetGuildId: text("target_guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    sourceGuildId: text("source_guild_id").notNull(),
    /** null = every event of the source guild. */
    sourceEventId: text("source_event_id"),
    createdBy: text("created_by").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sync_links_unique").on(t.targetGuildId, t.sourceGuildId, t.sourceEventId).nullsNotDistinct(),
    index("sync_links_source_idx").on(t.sourceGuildId),
  ],
);

export type MirrorStatus = "active" | "removing" | "detached";

/**
 * A copy of a source event inside a target guild. Keyed by (target, source
 * event) so overlapping links still produce one mirror. `detached` marks a
 * mirror someone deleted by hand: it is not re-created.
 */
export const syncMirrors = pgTable(
  "sync_mirrors",
  {
    targetGuildId: text("target_guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id").notNull(),
    /** Discord id of the mirror; null while the create call is in flight. */
    targetEventId: text("target_event_id").unique(),
    status: text("status").$type<MirrorStatus>().notNull(),
    /** Source `sequence` last copied, so unchanged events are skipped. */
    sourceSequence: integer("source_sequence").notNull().default(-1),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.targetGuildId, t.sourceEventId] })],
);

export type Guild = typeof guilds.$inferSelect;
export type SyncLink = typeof syncLinks.$inferSelect;
export type SyncMirror = typeof syncMirrors.$inferSelect;
export type ScheduledEvent = typeof scheduledEvents.$inferSelect;
export type NewScheduledEvent = typeof scheduledEvents.$inferInsert;
export type Rsvp = typeof rsvps.$inferSelect;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
