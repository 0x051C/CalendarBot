import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema";
import type { Database } from "../../src/db";

/** A fresh in-process Postgres (PGlite) with the real migrations applied. */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  return { db: db as unknown as Database, close: () => client.close() };
}
