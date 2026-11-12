import { and, eq, inArray, isNull, like, lt, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../index";
import { guilds, scheduledEvents, syncLinks, syncMirrors, type ScheduledEvent, type SyncLink, type SyncMirror } from "../schema";
import { guildOnShards } from "./events";

export interface CoveredEvent {
  event: ScheduledEvent;
  sourceGuildName: string;
}

export interface LinkView extends SyncLink {
  sourceGuildName: string | null;
  sourceEventName: string | null;
}

export class SyncRepository {
  constructor(private readonly db: Database) {}

  // --- links ------------------------------------------------------------------

  /** Returns undefined if an identical link already exists. */
  async createLink(link: { targetGuildId: string; sourceGuildId: string; sourceEventId: string | null; createdBy: string }) {
    const [row] = await this.db.insert(syncLinks).values(link).onConflictDoNothing().returning();
    return row;
  }

  async hasWholeGuildLink(targetGuildId: string, sourceGuildId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: syncLinks.id })
      .from(syncLinks)
      .where(and(eq(syncLinks.targetGuildId, targetGuildId), eq(syncLinks.sourceGuildId, sourceGuildId), isNull(syncLinks.sourceEventId)));
    return Boolean(row);
  }

  async linksForTarget(targetGuildId: string): Promise<LinkView[]> {
    const src = alias(guilds, "src");
    const rows = await this.db
      .select({ link: syncLinks, sourceGuildName: src.name, sourceEventName: scheduledEvents.name })
      .from(syncLinks)
      .leftJoin(src, eq(src.id, syncLinks.sourceGuildId))
      .leftJoin(scheduledEvents, eq(scheduledEvents.id, syncLinks.sourceEventId))
      .where(eq(syncLinks.targetGuildId, targetGuildId))
      .orderBy(syncLinks.createdAt);
    return rows.map((r) => ({ ...r.link, sourceGuildName: r.sourceGuildName, sourceEventName: r.sourceEventName }));
  }

  async deleteLink(id: string, targetGuildId: string): Promise<SyncLink | undefined> {
    const [row] = await this.db
      .delete(syncLinks)
      .where(and(eq(syncLinks.id, id), eq(syncLinks.targetGuildId, targetGuildId)))
      .returning();
    return row;
  }

  /** Target guilds that must hear about a change to these source events (or the whole source guild). */
  async targetsForSource(sourceGuildId: string, eventIds?: readonly string[]): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ target: syncLinks.targetGuildId })
      .from(syncLinks)
      .where(
        and(
          eq(syncLinks.sourceGuildId, sourceGuildId),
          eventIds?.length ? or(isNull(syncLinks.sourceEventId), inArray(syncLinks.sourceEventId, [...eventIds])) : undefined,
        ),
      );
    return rows.map((r) => r.target);
  }

  /** Target guilds served by these shards (for the initial/periodic reconcile). */
  async targetsOnShards(shardCount: number, shardIds: readonly number[]): Promise<string[]> {
    if (shardIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ target: syncLinks.targetGuildId })
      .from(syncLinks)
      .where(guildOnShards(sql`${syncLinks.targetGuildId}`, shardCount, shardIds));
    return rows.map((r) => r.target);
  }

  // --- desired state ----------------------------------------------------------

  /**
   * Source events the target should mirror: any event covered by one of the
   * target's links. Mirrors are never sources, which is what stops A→B→A syncs
   * from ping-ponging: they are excluded both by the mirror table and by
   * creator (the bot only creates events as mirrors), which also covers the
   * moment between creating a mirror and recording its id.
   */
  async coveredSourceEvents(targetGuildId: string, botUserId: string): Promise<CoveredEvent[]> {
    const e = scheduledEvents;
    const src = alias(guilds, "src");
    const rows = await this.db
      .selectDistinctOn([e.id], { event: e, sourceGuildName: src.name })
      .from(e)
      .innerJoin(
        syncLinks,
        and(
          eq(syncLinks.targetGuildId, targetGuildId),
          eq(syncLinks.sourceGuildId, e.guildId),
          or(isNull(syncLinks.sourceEventId), eq(syncLinks.sourceEventId, e.id)),
        ),
      )
      .innerJoin(src, eq(src.id, e.guildId))
      .where(
        and(
          ne(e.guildId, targetGuildId),
          sql`${e.creatorId} is distinct from ${botUserId}`,
          notExists(this.db.select({ one: sql`1` }).from(syncMirrors).where(eq(syncMirrors.targetEventId, e.id))),
        ),
      )
      .orderBy(e.id);
    return rows;
  }

  // --- mirrors ----------------------------------------------------------------

  async mirrors(targetGuildId: string): Promise<SyncMirror[]> {
    return this.db.select().from(syncMirrors).where(eq(syncMirrors.targetGuildId, targetGuildId));
  }

  /** Reserve the mirror slot before calling Discord, so two workers never both create it. */
  async claimMirror(targetGuildId: string, sourceEventId: string): Promise<SyncMirror | undefined> {
    const [row] = await this.db
      .insert(syncMirrors)
      .values({ targetGuildId, sourceEventId, status: "active" })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Take over a claim whose create call never completed (worker died mid-flight). */
  async reclaimStale(targetGuildId: string, sourceEventId: string, staleBefore: Date): Promise<boolean> {
    const rows = await this.db
      .update(syncMirrors)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(syncMirrors.targetGuildId, targetGuildId),
          eq(syncMirrors.sourceEventId, sourceEventId),
          isNull(syncMirrors.targetEventId),
          lt(syncMirrors.updatedAt, staleBefore),
        ),
      )
      .returning();
    return rows.length > 0;
  }

  async setMirrored(targetGuildId: string, sourceEventId: string, targetEventId: string, sourceSequence: number) {
    await this.db
      .update(syncMirrors)
      .set({ targetEventId, sourceSequence, status: "active", updatedAt: sql`now()` })
      .where(and(eq(syncMirrors.targetGuildId, targetGuildId), eq(syncMirrors.sourceEventId, sourceEventId)));
  }

  async setStatus(targetGuildId: string, sourceEventId: string, status: SyncMirror["status"]) {
    await this.db
      .update(syncMirrors)
      .set({ status, updatedAt: sql`now()` })
      .where(and(eq(syncMirrors.targetGuildId, targetGuildId), eq(syncMirrors.sourceEventId, sourceEventId)));
  }

  async deleteMirror(targetGuildId: string, sourceEventId: string) {
    await this.db
      .delete(syncMirrors)
      .where(and(eq(syncMirrors.targetGuildId, targetGuildId), eq(syncMirrors.sourceEventId, sourceEventId)));
  }

  /** A mirror was deleted in Discord by a person: remember not to re-create it. */
  async detachByTargetEvent(targetEventId: string): Promise<SyncMirror | undefined> {
    const [row] = await this.db
      .update(syncMirrors)
      .set({ status: "detached", updatedAt: sql`now()` })
      .where(and(eq(syncMirrors.targetEventId, targetEventId), eq(syncMirrors.status, "active")))
      .returning();
    return row;
  }

  /** Find an un-tracked mirror left by a crashed create call (its description links to the source). */
  async findOrphanMirror(targetGuildId: string, sourceEventUrl: string): Promise<string | undefined> {
    const e = scheduledEvents;
    const [row] = await this.db
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          eq(e.guildId, targetGuildId),
          like(e.description, `%${sourceEventUrl}%`),
          notExists(this.db.select({ one: sql`1` }).from(syncMirrors).where(eq(syncMirrors.targetEventId, e.id))),
        ),
      )
      .limit(1);
    return row?.id;
  }
}
