import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
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

export type Guild = typeof guilds.$inferSelect;
export type ScheduledEvent = typeof scheduledEvents.$inferSelect;
export type NewScheduledEvent = typeof scheduledEvents.$inferInsert;
export type Rsvp = typeof rsvps.$inferSelect;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
