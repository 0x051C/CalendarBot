import { eq, sql } from "drizzle-orm";
import type { Database } from "../index";
import { guilds, type Guild } from "../schema";

export class GuildRepository {
  constructor(private readonly db: Database) {}

  /** Create the guild with default settings, or refresh its name. */
  async ensure(id: string, name: string, defaultLeadMinutes: number): Promise<Guild> {
    const [row] = await this.db
      .insert(guilds)
      .values({ id, name, alertLeadMinutes: defaultLeadMinutes })
      .onConflictDoUpdate({
        target: guilds.id,
        set: { name, updatedAt: sql`now()` },
      })
      .returning();
    return row!;
  }

  async get(id: string): Promise<Guild | undefined> {
    const [row] = await this.db.select().from(guilds).where(eq(guilds.id, id));
    return row;
  }

  async setLeadMinutes(id: string, minutes: number): Promise<void> {
    await this.db
      .update(guilds)
      .set({ alertLeadMinutes: minutes, updatedAt: sql`now()` })
      .where(eq(guilds.id, id));
  }

  async setAlertChannel(id: string, channelId: string | null): Promise<void> {
    await this.db
      .update(guilds)
      .set({ alertChannelId: channelId, updatedAt: sql`now()` })
      .where(eq(guilds.id, id));
  }

  /** Forget a guild the bot was removed from (cascades to events, RSVPs, deliveries). */
  async delete(id: string): Promise<void> {
    await this.db.delete(guilds).where(eq(guilds.id, id));
  }
}
