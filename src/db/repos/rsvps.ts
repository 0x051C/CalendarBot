import { eq, sql } from "drizzle-orm";
import type { Database } from "../index";
import { rsvps, type Rsvp, type RsvpStatus } from "../schema";

export class RsvpRepository {
  constructor(private readonly db: Database) {}

  async set(eventId: string, userId: string, status: RsvpStatus): Promise<void> {
    await this.db
      .insert(rsvps)
      .values({ eventId, userId, status })
      .onConflictDoUpdate({
        target: [rsvps.eventId, rsvps.userId],
        set: { status, updatedAt: sql`now()` },
      });
  }

  async list(eventId: string): Promise<Rsvp[]> {
    return this.db.select().from(rsvps).where(eq(rsvps.eventId, eventId));
  }
}
