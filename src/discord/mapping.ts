import { GuildScheduledEventStatus, type GuildScheduledEvent } from "discord.js";
import type { EventStatus, NewScheduledEvent } from "../db/schema";

const STATUS: Record<GuildScheduledEventStatus, EventStatus> = {
  [GuildScheduledEventStatus.Scheduled]: "scheduled",
  [GuildScheduledEventStatus.Active]: "active",
  [GuildScheduledEventStatus.Completed]: "completed",
  [GuildScheduledEventStatus.Canceled]: "cancelled",
};

/** Map a Discord scheduled event to a database row. */
export function toEventRow(ev: GuildScheduledEvent): NewScheduledEvent {
  const location =
    ev.entityMetadata?.location ??
    (ev.channelId ? `https://discord.com/channels/${ev.guildId}/${ev.channelId}` : null);
  return {
    id: ev.id,
    guildId: ev.guildId,
    name: ev.name,
    description: ev.description || null,
    location,
    url: ev.url,
    creatorId: ev.creatorId,
    channelId: ev.channelId,
    startsAt: new Date(ev.scheduledStartTimestamp ?? Date.now()),
    endsAt: ev.scheduledEndTimestamp ? new Date(ev.scheduledEndTimestamp) : null,
    status: STATUS[ev.status] ?? "scheduled",
    createdAt: new Date(ev.createdTimestamp),
  };
}
