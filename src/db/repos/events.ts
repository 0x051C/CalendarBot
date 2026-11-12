import { and, asc, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../index";
import {
  alertDeliveries,
  guilds,
  scheduledEvents,
  type NewScheduledEvent,
  type ScheduledEvent,
} from "../schema";

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** SQL predicate: the guild's gateway shard is one of `shardIds`. */
export function guildOnShards(column: SQL | typeof scheduledEvents.guildId, shardCount: number, shardIds: readonly number[]): SQL {
  const ids = sql.join(shardIds.map((s) => sql.raw(String(Math.trunc(s)))), sql`, `);
  return sql`((${column})::bigint >> 22) % ${sql.raw(String(Math.trunc(shardCount)))} in (${ids})`;
}

export interface DueAlert {
  event: ScheduledEvent;
  leadMinutes: number;
  channelOverride: string | null;
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  /** Insert or update from Discord, bumping SEQUENCE only when visible fields change. */
  async upsert(row: NewScheduledEvent): Promise<ScheduledEvent> {
    const e = scheduledEvents;
    const [saved] = await this.db
      .insert(e)
      .values(row)
      .onConflictDoUpdate({
        target: e.id,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          location: sql`excluded.location`,
          url: sql`excluded.url`,
          creatorId: sql`excluded.creator_id`,
          channelId: sql`excluded.channel_id`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          status: sql`excluded.status`,
          sequence: sql`${e.sequence} + case when
            (${e.name}, ${e.description}, ${e.location}, ${e.startsAt}, ${e.endsAt}, ${e.status})
            is distinct from
            (excluded.name, excluded.description, excluded.location, excluded.starts_at, excluded.ends_at, excluded.status)
            then 1 else 0 end`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return saved!;
  }

  async get(id: string): Promise<ScheduledEvent | undefined> {
    const [row] = await this.db.select().from(scheduledEvents).where(eq(scheduledEvents.id, id));
    return row;
  }

  /** Mark an event cancelled. Returns the row only if it was not already cancelled. */
  async markCancelled(id: string): Promise<ScheduledEvent | undefined> {
    const [row] = await this.db
      .update(scheduledEvents)
      .set({ status: "cancelled", sequence: sql`${scheduledEvents.sequence} + 1`, updatedAt: sql`now()` })
      .where(and(eq(scheduledEvents.id, id), sql`${scheduledEvents.status} <> 'cancelled'`))
      .returning();
    return row;
  }

  /** Cancel upcoming/active events Discord no longer reports (deleted while we were offline). */
  async cancelMissing(guildId: string, presentIds: readonly string[]): Promise<ScheduledEvent[]> {
    const e = scheduledEvents;
    return this.db
      .update(e)
      .set({ status: "cancelled", sequence: sql`${e.sequence} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(e.guildId, guildId),
          inArray(e.status, ["scheduled", "active"]),
          presentIds.length ? notInArray(e.id, [...presentIds]) : undefined,
        ),
      )
      .returning();
  }

  async listForCalendar(guildId: string, since: Date): Promise<ScheduledEvent[]> {
    return this.db
      .select()
      .from(scheduledEvents)
      .where(and(eq(scheduledEvents.guildId, guildId), gte(scheduledEvents.startsAt, since)))
      .orderBy(asc(scheduledEvents.startsAt));
  }

  async upcoming(guildId: string, now: Date, limit = 5): Promise<ScheduledEvent[]> {
    return this.db
      .select()
      .from(scheduledEvents)
      .where(
        and(eq(scheduledEvents.guildId, guildId), eq(scheduledEvents.status, "scheduled"), gt(scheduledEvents.startsAt, now)),
      )
      .orderBy(asc(scheduledEvents.startsAt))
      .limit(limit);
  }

  /**
   * Events on the given shards whose alert window has opened, which have not
   * started yet and have no live delivery claim (none yet, a retryable
   * failure, or a pending claim abandoned by a crashed instance).
   */
  async findDue(opts: {
    now: Date;
    shardCount: number;
    shardIds: readonly number[];
    staleClaimBefore: Date;
    maxAttempts: number;
    limit?: number;
  }): Promise<DueAlert[]> {
    if (opts.shardIds.length === 0) return [];
    const e = scheduledEvents;
    const d = alertDeliveries;
    const rows = await this.db
      .select({ event: e, leadMinutes: guilds.alertLeadMinutes, channelOverride: guilds.alertChannelId })
      .from(e)
      .innerJoin(guilds, eq(guilds.id, e.guildId))
      .leftJoin(d, and(eq(d.eventId, e.id), eq(d.startsAt, e.startsAt)))
      .where(
        and(
          eq(e.status, "scheduled"),
          gt(e.startsAt, opts.now),
          sql`${e.startsAt} - make_interval(mins => ${guilds.alertLeadMinutes}) <= ${ts(opts.now)}`,
          or(
            isNull(d.eventId),
            and(eq(d.status, "failed"), lt(d.attempts, opts.maxAttempts)),
            and(eq(d.status, "pending"), lt(d.claimedAt, opts.staleClaimBefore)),
          ),
          guildOnShards(e.guildId, opts.shardCount, opts.shardIds),
        ),
      )
      .orderBy(asc(e.startsAt))
      .limit(opts.limit ?? 50);
    return rows;
  }
}
