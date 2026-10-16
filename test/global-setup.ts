import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrations/run-migrations';

/** Brings wallet_test's public schema up to date before any e2e suite runs. */
export default async function globalSetup(): Promise<void> {
  // Runs outside the per-file sandbox, so load the same env the suites use.
  await import('./setup-env');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
