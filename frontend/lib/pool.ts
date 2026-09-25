import { Pool, type PoolConfig } from "pg";
import { databaseCaCert, databaseUrl } from "./env";

// One pool per lambda/container instance. `max` is small on purpose: Vercel
// runs many instances, and Supabase's pooler has a connection ceiling — behind
// the transaction pooler one connection per instance is the right shape.
const globalForPool = globalThis as unknown as { _cgPool?: Pool };

// Connection-string TLS settings that would override the `ssl` option below:
// node-postgres lets the URL win over the config object.
const URL_TLS_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

/**
 * TLS for the database connection.
 *
 * Supabase signs its certificates with its own root CA, which Node does not
 * trust by default, and node-postgres treats `sslmode=require` as full
 * verification — so a plain Supabase URL fails with "self-signed certificate
 * in certificate chain". The fix is to trust that CA, not to stop verifying:
 * with DATABASE_CA_CERT set (the PEM from Supabase's database settings), the
 * connection is verified against it, hostname included. Without it, the URL's
 * own settings apply (fine for a local Postgres without TLS).
 */
export function poolConfig(): PoolConfig {
  const ca = databaseCaCert();
  if (!ca) return { connectionString: databaseUrl() };
  const url = new URL(databaseUrl());
  for (const p of URL_TLS_PARAMS) url.searchParams.delete(p);
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

export function pool(): Pool {
  if (!globalForPool._cgPool) {
    globalForPool._cgPool = new Pool({
      ...poolConfig(),
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
