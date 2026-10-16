import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { validateEnv } from '../../config/configuration';
import { buildPoolConfig } from '../database.constants';
import { withTransaction } from '../with-transaction';

// Arbitrary fixed key; every runner must use the same one.
const MIGRATION_LOCK_KEY = 727_001;

export async function runMigrations(pool: Pool, dir: string = __dirname): Promise<string[]> {
  // Session-level lock held on its own connection for the whole run, so a
  // second deploy waits here and then finds nothing left to apply.
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await lockClient.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.filename));

    const pending = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !applied.has(f))
      .sort();

    for (const filename of pending) {
      const sql = readFileSync(join(dir, filename), 'utf8');
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      });
      console.log(`migrate: applied ${filename}`);
    }
    return pending;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
      // The lock is dropped with the session anyway.
    });
    lockClient.release();
  }
}

export interface AdminSeed {
  email: string;
  password: string;
  phone: string;
  fullName: string;
}

/** Creates the admin user and their NGN wallet unless an admin already exists. */
export async function seedAdmin(pool: Pool, admin: AdminSeed): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    // Serialises concurrent deploys so both can't see "no admin" and insert.
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    const existing = await client.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) {
      return false;
    }

    const passwordHash = await argon2.hash(admin.password);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id`,
      [admin.email.trim().toLowerCase(), admin.phone, admin.fullName, passwordHash],
    );
    await client.query("INSERT INTO wallets (user_id, currency) VALUES ($1, 'NGN')", [rows[0].id]);
    return true;
  });
}

async function main(): Promise<void> {
  // Locally, read .env; on Render the variables are already in the environment.
  // loadEnvFile never overrides variables that are already set.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const env = validateEnv(process.env);
  // Lock connection + one transaction connection.
  const pool = new Pool({ ...buildPoolConfig(env.DATABASE_URL, env.DATABASE_SSL), max: 2 });
  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('migrate: up to date');
    }

    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      const created = await seedAdmin(pool, {
        email: env.ADMIN_EMAIL,
        password: env.ADMIN_PASSWORD,
        phone: env.ADMIN_PHONE,
        fullName: env.ADMIN_FULL_NAME,
      });
      console.log(created ? `seed: created admin ${env.ADMIN_EMAIL}` : 'seed: admin exists');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('migrate: failed', err);
    process.exit(1);
  });
}
