import type { Guild, GuildScheduledEvent, PartialGuildScheduledEvent } from "discord.js";
import type { AlertService } from "../alerts/alert-service";
import type { CalendarExporter } from "../calendar/exporter";
import type { EventRepository } from "../db/repos/events";
import type { GuildRepository } from "../db/repos/guilds";
import type { Logger } from "../logger";
import { toEventRow } from "./mapping";

export interface EventSyncHooks {
  /** Source-side: events of `guildId` changed (all of them when `eventIds` is undefined). */
  sourceChanged(guildId: string, eventIds: string[] | undefined, reason: string): Promise<void>;
  /** A Discord event was deleted (it may have been a mirror deleted by hand). */
  eventDeleted(eventId: string): Promise<void>;
}

/** Keeps Postgres in step with Discord's scheduled events. */
export class EventSync {
  private hooks: EventSyncHooks | null = null;

  setHooks(hooks: EventSyncHooks) {
    this.hooks = hooks;
  }

  constructor(
    private readonly deps: {
      guilds: GuildRepository;
      events: EventRepository;
      alertService: AlertService;
      exporter: CalendarExporter;
      defaultLeadMinutes: number;
      logger: Logger;
    },
  ) {}

  /** Full reconciliation, run when a shard becomes ready or a guild becomes available. */
  async syncGuild(guild: Guild): Promise<void> {
    await this.deps.guilds.ensure(guild.id, guild.name, this.deps.defaultLeadMinutes);
    const fetched = await guild.scheduledEvents.fetch();
    for (const ev of fetched.values()) await this.deps.events.upsert(toEventRow(ev));

    const cancelled = await this.deps.events.cancelMissing(guild.id, [...fetched.keys()]);
    for (const row of cancelled) await this.deps.alertService.refreshPosted(row, guild);

    this.deps.exporter.schedule(guild.id);
    await this.hooks?.sourceChanged(guild.id, undefined, "guild synced");
    this.deps.logger.info({ guildId: guild.id, events: fetched.size, cancelled: cancelled.length }, "guild synced");
  }

  async upsert(ev: GuildScheduledEvent): Promise<void> {
    if (!ev.guild) return;
    await this.deps.guilds.ensure(ev.guild.id, ev.guild.name, this.deps.defaultLeadMinutes);
    const row = await this.deps.events.upsert(toEventRow(ev));
    await this.deps.alertService.refreshPosted(row, ev.guild);
    this.deps.exporter.schedule(ev.guildId);
    await this.hooks?.sourceChanged(ev.guildId, [ev.id], "event changed");
  }

  async remove(ev: GuildScheduledEvent | PartialGuildScheduledEvent): Promise<void> {
    await this.hooks?.eventDeleted(ev.id);
    if (ev.guild) await this.cancel(ev.id, ev.guild);
  }

  async cancel(eventId: string, guild: Guild): Promise<void> {
    const row = await this.deps.events.markCancelled(eventId);
    if (!row) return; // unknown or already cancelled
    await this.deps.alertService.refreshPosted(row, guild);
    this.deps.exporter.schedule(guild.id);
    await this.hooks?.sourceChanged(guild.id, [eventId], "event cancelled");
  }

  /** Someone toggled "Interested" on the event: refresh the attendee list on posted alerts. */
  async refreshAttendance(eventId: string, guild: Guild): Promise<void> {
    const row = await this.deps.events.get(eventId);
    if (row) await this.deps.alertService.refreshPosted(row, guild);
  }

  async renameGuild(guild: Guild): Promise<void> {
    await this.deps.guilds.ensure(guild.id, guild.name, this.deps.defaultLeadMinutes);
    this.deps.exporter.schedule(guild.id);
  }
}
