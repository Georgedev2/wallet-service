import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { createApp } from './helpers';

export interface TestUser {
  userId: string;
  walletId: string;
  token: string;
}

export const newKey = () => `key-${randomUUID()}`;

/**
 * Shared setup for the concurrency and idempotency specs: a listening app, an admin,
 * users with funded wallets, and the reconciliation checks. Tracks everything it
 * creates so stop() can clean up.
 */
export class MoneyKit {
  private readonly userIds: string[] = [];
  private readonly walletIds: string[] = [];

  private constructor(
    readonly app: INestApplication,
    readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly adminToken: string,
  ) {}

  static async start(): Promise<MoneyKit> {
    const app = await createApp();
    // supertest would otherwise call listen() once per request, and parallel
    // requests on an unbound server throw ERR_SERVER_ALREADY_LISTEN.
    await app.listen(0);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const jwt = app.get(JwtService);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role)
       VALUES ($1, $2, 'Admin', 'not-a-real-hash', 'admin') RETURNING id`,
      [`admin-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`],
    );
    const kit = new MoneyKit(app, pool, jwt, jwt.sign({ sub: rows[0].id, role: 'admin' }));
    kit.userIds.push(rows[0].id);
    return kit;
  }

  async stop(): Promise<void> {
    const wallets = 'SELECT id FROM wallets WHERE user_id = ANY($1::uuid[])';
    await this.pool.query(`DELETE FROM ledger_entries WHERE wallet_id IN (${wallets})`, [
      this.userIds,
    ]);
    await this.pool.query(
      `DELETE FROM transactions WHERE initiated_by = ANY($1::uuid[])
          OR destination_wallet_id IN (${wallets}) OR source_wallet_id IN (${wallets})`,
      [this.userIds],
    );
    await this.pool.query('DELETE FROM wallets WHERE user_id = ANY($1::uuid[])', [this.userIds]);
    await this.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [this.userIds]);
    await this.pool.end();
    await this.app.close();
  }

  /** A user with an NGN wallet, optionally funded through the real admin endpoint. */
  async createUser(funds?: string): Promise<TestUser> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash)
       VALUES ($1, $2, 'Test User', 'not-a-real-hash') RETURNING id`,
      [`user-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`],
    );
    const userId = rows[0].id;
    this.userIds.push(userId);
    const wallet = await this.pool.query<{ id: string }>(
      'INSERT INTO wallets (user_id) VALUES ($1) RETURNING id',
      [userId],
    );
    const user: TestUser = {
      userId,
      walletId: wallet.rows[0].id,
      token: this.jwt.sign({ sub: userId, role: 'user' }),
    };
    this.walletIds.push(user.walletId);
    if (funds) {
      await this.fund(user.walletId, funds).expect(201);
    }
    return user;
  }

  fund(walletId: string, amount: string, idemKey = newKey()) {
    return request(this.app.getHttpServer())
      .post(`/admin/wallets/${walletId}/fund`)
      .set('Authorization', `Bearer ${this.adminToken}`)
      .set('Idempotency-Key', idemKey)
      .send({ amount });
  }

  transfer(from: TestUser, to: TestUser, amount: string, idemKey = newKey()) {
    return request(this.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${from.token}`)
      .set('Idempotency-Key', idemKey)
      .send({ sourceWalletId: from.walletId, destinationWalletId: to.walletId, amount });
  }

  async balanceOf(walletId: string): Promise<string> {
    const { rows } = await this.pool.query<{ b: string }>(
      'SELECT balance::text AS b FROM wallets WHERE id = $1',
      [walletId],
    );
    return rows[0].b;
  }

  /**
   * Integrity checks over every wallet this kit created:
   * - each balance equals its credits minus its debits (CLAUDE.md rule 5);
   * - each transfer has exactly one debit on the source and one credit on the
   *   destination, both for the transaction amount;
   * - each funding has exactly one credit on the destination (it is single-entry).
   */
  async expectReconciled(): Promise<void> {
    const { rows: unbalanced } = await this.pool.query(
      `SELECT w.id, w.balance::text AS balance,
              COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0)::text
                AS ledger
         FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id
       HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0)`,
      [this.walletIds],
    );
    expect(unbalanced).toEqual([]);

    const { rows: malformed } = await this.pool.query(
      `SELECT t.reference, t.type, t.amount::text AS amount,
              count(l.id)::int AS entries,
              count(*) FILTER (WHERE l.direction = 'debit' AND l.wallet_id = t.source_wallet_id
                                 AND l.amount = t.amount)::int AS debits,
              count(*) FILTER (WHERE l.direction = 'credit' AND l.wallet_id = t.destination_wallet_id
                                 AND l.amount = t.amount)::int AS credits
         FROM transactions t LEFT JOIN ledger_entries l ON l.transaction_id = t.id
        WHERE t.source_wallet_id = ANY($1::uuid[]) OR t.destination_wallet_id = ANY($1::uuid[])
        GROUP BY t.id`,
      [this.walletIds],
    );
    const bad = malformed.filter((t) =>
      t.type === 'transfer'
        ? !(t.entries === 2 && t.debits === 1 && t.credits === 1)
        : !(t.entries === 1 && t.credits === 1),
    );
    expect(bad).toEqual([]);
  }
}
