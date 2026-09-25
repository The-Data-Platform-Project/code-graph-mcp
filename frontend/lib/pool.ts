import { Pool } from "pg";
import { databaseUrl } from "./env";

// One pool per lambda/container instance. `max` is small on purpose: Vercel
// runs many instances, and Supabase's pooler has a connection ceiling — behind
// the transaction pooler one connection per instance is the right shape.
const globalForPool = globalThis as unknown as { _cgPool?: Pool };

export function pool(): Pool {
  if (!globalForPool._cgPool) {
    globalForPool._cgPool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.PGPOOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPool._cgPool;
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool().query(sql, params);
  return result.rows as T[];
}
