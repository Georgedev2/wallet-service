import { PoolConfig } from 'pg';

export const PG_POOL = 'PG_POOL';

export function buildPoolConfig(databaseUrl: string, ssl: boolean): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: 10,
    // Fail instead of waiting forever when Postgres is unreachable (pg's default is no timeout).
    connectionTimeoutMillis: 5000,
    // Render's managed Postgres uses a certificate Node doesn't trust by default.
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  };
}
