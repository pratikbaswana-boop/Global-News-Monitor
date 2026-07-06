import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Pool size: each thread (main + worker) gets its own Pool instance via module
// import. Default max=10 would give 20 total across both threads. Size down to
// 5 per thread (10 total) to stay within typical DB max_connections limits.
// Override via DB_POOL_MAX env var if your DB allows more.
const poolMax = parseInt(process.env["DB_POOL_MAX"] ?? "5", 10);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: poolMax });
export const db = drizzle(pool, { schema });

export * from "./schema";
