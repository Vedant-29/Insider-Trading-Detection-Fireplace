/**
 * Drizzle DB client. Single shared instance.
 * Import as: import { db } from "../lib/db.js"
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set in environment");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Keepalive: keep TCP alive across long idle periods
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// CRITICAL: pg pool emits 'error' on idle clients.
// If we don't handle this, pool clients silently die and next consumer
// gets a dead connection. Force re-creation by removing them.
pool.on("error", (err, client) => {
  console.warn(`[db pool] idle client error: ${err.message}. Removing client.`);
  // pg will discard this client automatically once 'error' is emitted
});

export const db = drizzle(pool, { schema });

export { schema };
