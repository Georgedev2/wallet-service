import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { runMigrations, seedAdmin } from '../src/database/migrations/run-migrations';
import { withTransaction } from '../src/database/with-transaction';

// Each suite works in its own Postgres schema so it never collides with the
// real migrations in wallet_test.
function poolFor(schema: string, max = 2): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    options: `-c search_path=${schema}`,
  });
}

async function resetSchema(schema: string): Promise<void> {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await admin.end();
}

async function dropSchema(schema: string): Promise<void> {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}

describe('withTransaction', () => {
  const schema = 'test_with_tx';
  let pool: Pool;

  beforeAll(async () => {
    await resetSchema(schema);
    // max 1: if a client were ever leaked, the next test would hang.
    pool = poolFor(schema, 1);
    await pool.query('CREATE TABLE items (name TEXT NOT NULL)');
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE items');
  });

  afterAll(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  it('commits and returns the callback result', async () => {
    const result = await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO items VALUES ('a')");
      return 42;
    });

    expect(result).toBe(42);
    const { rows } = await pool.query('SELECT name FROM items');
    expect(rows).toEqual([{ name: 'a' }]);
    expect(pool.idleCount).toBe(pool.totalCount);
  });

  it('rolls back and rethrows the original error', async () => {
    const boom = new Error('boom');
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO items VALUES ('a')");
        throw boom;
      }),
    ).rejects.toBe(boom);

    const { rows } = await pool.query('SELECT name FROM items');
    expect(rows).toEqual([]);
    expect(pool.idleCount).toBe(pool.totalCount);
  });

  it('rolls back when a query fails', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO items VALUES ('a')");
        await client.query('INSERT INTO items VALUES (NULL)');
      }),
    ).rejects.toThrow(/null value/);

    const { rows } = await pool.query('SELECT name FROM items');
    expect(rows).toEqual([]);
  });
});

describe('runMigrations', () => {
  const schema = 'test_migrations';
  let dir: string;
  let pool: Pool;

  beforeEach(async () => {
    await resetSchema(schema);
    pool = poolFor(schema);
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    // Written out of order to prove filename sorting.
    writeFileSync(join(dir, '002_b.sql'), 'ALTER TABLE a ADD COLUMN extra TEXT;');
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INT); CREATE TABLE a2 (id INT);');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
  });

  afterEach(async () => {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await dropSchema(schema);
  });

  async function recorded(): Promise<string[]> {
    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    return rows.map((r) => r.filename);
  }

  it('applies pending .sql files in filename order and records them', async () => {
    expect(await runMigrations(pool, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect(await recorded()).toEqual(['001_a.sql', '002_b.sql']);
    await pool.query('SELECT id, extra FROM a');
  });

  it('applies nothing on a second run, then only new files', async () => {
    await runMigrations(pool, dir);
    expect(await runMigrations(pool, dir)).toEqual([]);

    writeFileSync(join(dir, '003_c.sql'), 'CREATE TABLE c (id INT);');
    expect(await runMigrations(pool, dir)).toEqual(['003_c.sql']);
  });

  it('rolls back a failing migration and does not record it', async () => {
    writeFileSync(join(dir, '003_bad.sql'), 'CREATE TABLE c (id INT); SELECT nope FROM missing;');

    await expect(runMigrations(pool, dir)).rejects.toThrow(/missing/);

    expect(await recorded()).toEqual(['001_a.sql', '002_b.sql']);
    const { rows } = await pool.query("SELECT to_regclass('c') AS t");
    expect(rows[0].t).toBeNull();
  });

  it('applies each migration exactly once when runners race', async () => {
    const other = poolFor(schema);
    try {
      const results = await Promise.all([runMigrations(pool, dir), runMigrations(other, dir)]);
      // One runner applies both; the other waits on the lock and finds nothing to do.
      expect(results.map((r) => r.length).sort()).toEqual([0, 2]);
      expect(await recorded()).toEqual(['001_a.sql', '002_b.sql']);
    } finally {
      await other.end();
    }
  });
});

describe('001_init.sql + seedAdmin', () => {
  const schema = 'test_seed';
  const admin = {
    email: ' Admin@Example.com ',
    password: 'admin-password',
    phone: '+2340000000000',
    fullName: 'Administrator',
  };
  let pool: Pool;

  beforeEach(async () => {
    await resetSchema(schema);
    pool = poolFor(schema);
    await runMigrations(pool); // the real migrations directory
  });

  afterEach(async () => {
    await pool.end();
  });

  afterAll(async () => {
    await dropSchema(schema);
  });

  it('creates every table in the schema', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [schema],
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'blacklist_entries',
      'ledger_entries',
      'schema_migrations',
      'transactions',
      'user_status_events',
      'users',
      'wallets',
    ]);
  });

  it('creates an admin with an argon2 hash and an empty NGN wallet', async () => {
    expect(await seedAdmin(pool, admin)).toBe(true);

    const { rows: users } = await pool.query(
      'SELECT id, email, role, status, password_hash FROM users',
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'admin@example.com', role: 'admin', status: 'active' });
    expect(users[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(users[0].password_hash, admin.password)).toBe(true);

    const { rows: wallets } = await pool.query('SELECT user_id, currency, balance FROM wallets');
    expect(wallets).toEqual([{ user_id: users[0].id, currency: 'NGN', balance: '0' }]);
  });

  it('does nothing when an admin already exists', async () => {
    await seedAdmin(pool, admin);
    expect(await seedAdmin(pool, { ...admin, email: 'other@example.com' })).toBe(false);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('creates exactly one admin when seeds race', async () => {
    const other = poolFor(schema);
    try {
      const results = await Promise.all([seedAdmin(pool, admin), seedAdmin(other, admin)]);
      expect(results.sort()).toEqual([false, true]);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM wallets');
      expect(rows[0].n).toBe(1);
    } finally {
      await other.end();
    }
  });
});
