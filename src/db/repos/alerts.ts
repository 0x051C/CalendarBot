import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../index";
import { alertDeliveries, type AlertDelivery } from "../schema";

export class AlertRepository {
  constructor(private readonly db: Database) {}

  /**
   * Atomically claim the right to send the alert for (event, start time).
   *
   * Succeeds when no delivery exists yet, when the previous attempt failed
   * and retries remain, or when a pending claim went stale (its instance
   * died mid-send). Concurrent callers race on the primary key, so at most
   * one gets a row back.
   */
  async claim(opts: {
    eventId: string;
    startsAt: Date;
    instanceId: string;
    now: Date;
    staleClaimBefore: Date;
    maxAttempts: number;
  }): Promise<AlertDelivery | undefined> {
    const d = alertDeliveries;
    const [row] = await this.db
      .insert(d)
      .values({
        eventId: opts.eventId,
        startsAt: opts.startsAt,
        status: "pending",
        attempts: 1,
        claimedBy: opts.instanceId,
        claimedAt: opts.now,
      })
      .onConflictDoUpdate({
        target: [d.eventId, d.startsAt],
        set: {
          status: "pending",
          attempts: sql`${d.attempts} + 1`,
          claimedBy: opts.instanceId,
          claimedAt: opts.now,
          error: null,
        },
        setWhere: or(
          and(eq(d.status, "failed"), lt(d.attempts, opts.maxAttempts)),
          and(eq(d.status, "pending"), lt(d.claimedAt, opts.staleClaimBefore)),
        ),
      })
      .returning();
    return row;
  }

  async markSent(eventId: string, startsAt: Date, channelId: string, messageId: string, now: Date) {
    await this.db
      .update(alertDeliveries)
      .set({ status: "sent", channelId, messageId, sentAt: now, error: null })
      .where(and(eq(alertDeliveries.eventId, eventId), eq(alertDeliveries.startsAt, startsAt)));
  }

  async markFailed(eventId: string, startsAt: Date, error: string) {
    await this.db
      .update(alertDeliveries)
      .set({ status: "failed", error: error.slice(0, 1000) })
      .where(and(eq(alertDeliveries.eventId, eventId), eq(alertDeliveries.startsAt, startsAt)));
  }

  /** Alert messages already posted for an event (to edit them on changes). */
  async postedMessages(eventId: string): Promise<AlertDelivery[]> {
    return this.db
      .select()
      .from(alertDeliveries)
      .where(and(eq(alertDeliveries.eventId, eventId), eq(alertDeliveries.status, "sent"), isNotNull(alertDeliveries.messageId)));
  }
}
