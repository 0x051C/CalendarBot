import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

/** Driver-agnostic handle (postgres.js in production, PGlite in tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function connectDatabase(url: string): DatabaseHandle & {
  migrate(migrationsFolder: string): Promise<void>;
} {
  const client = postgres(url, { max: 5, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Database,
    async ping() {
      await client`select 1`;
    },
    async close() {
      await client.end({ timeout: 5 });
    },
    /**
     * Apply pending migrations. Every instance runs this on boot, so a
     * session-level advisory lock serialises them.
     */
    async migrate(migrationsFolder: string) {
      const lock = await client.reserve();
      try {
        await lock`select pg_advisory_lock(hashtext('calendarbot:migrations'))`;
        await migrate(db, { migrationsFolder });
      } finally {
        await lock`select pg_advisory_unlock(hashtext('calendarbot:migrations'))`;
        lock.release();
      }
    },
  };
}

export { schema, sql };
