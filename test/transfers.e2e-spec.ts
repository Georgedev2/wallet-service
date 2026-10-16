import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { createApp } from './helpers';

interface TestUser {
  userId: string;
  walletId: string;
  token: string;
}

describe('POST /transfers (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  let adminToken: string;
  const userIds: string[] = [];

  /** A user with an NGN wallet, optionally funded through the real admin endpoint. */
  async function createUser(opts: { funds?: string; role?: 'user' | 'admin' } = {}) {
    const role = opts.role ?? 'user';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role)
       VALUES ($1, $2, 'Test User', 'not-a-real-hash', $3) RETURNING id`,
      [`user-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`, role],
    );
    const userId = rows[0].id;
    userIds.push(userId);
    const wallet = await pool.query<{ id: string }>(
      'INSERT INTO wallets (user_id) VALUES ($1) RETURNING id',
      [userId],
    );
    const user: TestUser = {
      userId,
      walletId: wallet.rows[0].id,
      token: jwt.sign({ sub: userId, role }),
    };
    if (opts.funds) {
      await request(app.getHttpServer())
        .post(`/admin/wallets/${user.walletId}/fund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key())
        .send({ amount: opts.funds })
        .expect(201);
    }
    return user;
  }

  const key = () => `key-${randomUUID()}`;

  const transfer = (sender: TestUser, body: object, idemKey: string | null = key()) => {
    const req = request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send(body);
    return idemKey ? req.set('Idempotency-Key', idemKey) : req;
  };

  const body = (from: TestUser, to: TestUser, amount = '1000', narration?: string) => ({
    sourceWalletId: from.walletId,
    destinationWalletId: to.walletId,
    amount,
    ...(narration === undefined ? {} : { narration }),
  });

  async function balanceOf(walletId: string): Promise<string> {
    const { rows } = await pool.query('SELECT balance::text AS b FROM wallets WHERE id = $1', [
      walletId,
    ]);
    return rows[0].b;
  }

  async function transferCount(walletId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM transactions
        WHERE type = 'transfer' AND (source_wallet_id = $1 OR destination_wallet_id = $1)`,
      [walletId],
    );
    return rows[0].n;
  }

  /** CLAUDE.md rule 5: each balance equals the sum of that wallet's ledger entries. */
  async function expectReconciled(...walletIds: string[]): Promise<void> {
    const { rows } = await pool.query(
      `SELECT w.id, w.balance::text AS balance,
              COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0)::text
                AS ledger
         FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id`,
      [walletIds],
    );
    for (const row of rows) {
      expect(row.balance).toBe(row.ledger);
    }
  }

  async function block(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET status = 'blocked', blocked_at = now() WHERE id = $1`, [
      userId,
    ]);
  }

  beforeAll(async () => {
    app = await createApp();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    jwt = app.get(JwtService);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role)
       VALUES ($1, $2, 'Admin', 'not-a-real-hash', 'admin') RETURNING id`,
      [`admin-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`],
    );
    userIds.push(rows[0].id);
    adminToken = jwt.sign({ sub: rows[0].id, role: 'admin' });
  });

  afterAll(async () => {
    const wallets = 'SELECT id FROM wallets WHERE user_id = ANY($1::uuid[])';
    await pool.query(`DELETE FROM ledger_entries WHERE wallet_id IN (${wallets})`, [userIds]);
    await pool.query(
      `DELETE FROM transactions WHERE initiated_by = ANY($1::uuid[])
          OR destination_wallet_id IN (${wallets}) OR source_wallet_id IN (${wallets})`,
      [userIds],
    );
    await pool.query('DELETE FROM wallets WHERE user_id = ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
    await app.close();
  });

  describe('happy path', () => {
    it('moves the money, writes a debit and a credit, and returns 201', async () => {
      const a = await createUser({ funds: '10000' });
      const b = await createUser();

      const res = await transfer(a, body(a, b, '2500', 'Lunch')).expect(201);

      expect(res.body.data).toEqual({
        reference: expect.stringMatching(/^TRF-[0-9A-F]{16}$/),
        amount: '2500',
        currency: 'NGN',
        sourceWalletId: a.walletId,
        destinationWalletId: b.walletId,
        narration: 'Lunch',
        status: 'completed',
        balanceAfter: '7500',
        createdAt: expect.any(String),
        replayed: false,
      });
      expect(await balanceOf(a.walletId)).toBe('7500');
      expect(await balanceOf(b.walletId)).toBe('2500');

      const { rows: entries } = await pool.query(
        `SELECT le.wallet_id, le.direction, le.amount::text AS amount,
                le.balance_after::text AS balance_after
           FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
          WHERE t.reference = $1
          ORDER BY le.direction DESC`,
        [res.body.data.reference],
      );
      expect(entries).toEqual([
        { wallet_id: a.walletId, direction: 'debit', amount: '2500', balance_after: '7500' },
        { wallet_id: b.walletId, direction: 'credit', amount: '2500', balance_after: '2500' },
      ]);
      await expectReconciled(a.walletId, b.walletId);
    });

    it('shows each side in its own history, with the other wallet as counterparty', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const res = await transfer(a, body(a, b, '1200')).expect(201);
      const ref = res.body.data.reference;

      const history = async (u: TestUser) =>
        (
          await request(app.getHttpServer())
            .get(`/wallets/${u.walletId}/transactions`)
            .set('Authorization', `Bearer ${u.token}`)
            .expect(200)
        ).body.data.items;

      expect((await history(a))[0]).toMatchObject({
        reference: ref,
        type: 'transfer',
        direction: 'debit',
        amount: '1200',
        balanceAfter: '3800',
        counterpartyWalletId: b.walletId,
      });
      expect((await history(b))[0]).toMatchObject({
        reference: ref,
        type: 'transfer',
        direction: 'credit',
        amount: '1200',
        balanceAfter: '1200',
        counterpartyWalletId: a.walletId,
      });
    });

    it('allows sending the exact balance, leaving 0', async () => {
      const a = await createUser({ funds: '3000' });
      const b = await createUser();
      await transfer(a, body(a, b, '3000')).expect(201);
      expect(await balanceOf(a.walletId)).toBe('0');
    });
  });

  describe('idempotency', () => {
    it('replays the same key with 200 and an identical body, moving money once', async () => {
      const a = await createUser({ funds: '10000' });
      const b = await createUser();
      const k = key();

      const first = await transfer(a, body(a, b, '1000'), k).expect(201);
      const second = await transfer(a, body(a, b, '1000'), k).expect(200);

      expect(second.body.data).toEqual({ ...first.body.data, replayed: true });
      expect(await balanceOf(a.walletId)).toBe('9000');
      expect(await transferCount(a.walletId)).toBe(1);
      await expectReconciled(a.walletId, b.walletId);
    });

    it('still replays after the recipient is blocked (the original result stands)', async () => {
      const a = await createUser({ funds: '10000' });
      const b = await createUser();
      const k = key();
      const first = await transfer(a, body(a, b), k).expect(201);
      await block(b.userId);

      const second = await transfer(a, body(a, b), k).expect(200);
      expect(second.body.data.reference).toBe(first.body.data.reference);
    });

    it.each([
      ['a different amount', (a: TestUser, b: TestUser) => body(a, b, '2000')],
      ['a different narration', (a: TestUser, b: TestUser) => body(a, b, '1000', 'changed')],
    ])('rejects the same key with %s with 409 IDEMPOTENCY_KEY_REUSED', async (_label, other) => {
      const a = await createUser({ funds: '10000' });
      const b = await createUser();
      const k = key();
      await transfer(a, body(a, b, '1000'), k).expect(201);

      const res = await transfer(a, other(a, b), k).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(a.walletId)).toBe('9000');
    });

    it('scopes keys per user: two users can use the same key', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser({ funds: '5000' });
      const k = key();

      await transfer(a, body(a, b), k).expect(201);
      await transfer(b, body(b, a), k).expect(201);
    });
  });

  describe('errors', () => {
    it('returns 404 WALLET_NOT_FOUND for an unknown destination or source', async () => {
      const a = await createUser({ funds: '5000' });
      const ghost = { ...a, walletId: randomUUID() };

      const toGhost = await transfer(a, body(a, ghost)).expect(404);
      expect(toGhost.body.error.code).toBe('WALLET_NOT_FOUND');
      const fromGhost = await transfer(a, body(ghost, a)).expect(404);
      expect(fromGhost.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it("rejects sending from someone else's wallet with 403 FORBIDDEN", async () => {
      const victim = await createUser({ funds: '5000' });
      const thief = await createUser();

      const res = await transfer(thief, body(victim, thief)).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await balanceOf(victim.walletId)).toBe('5000');
    });

    it('does not let an admin send from a user wallet either', async () => {
      const victim = await createUser({ funds: '5000' });
      const admin = await createUser({ role: 'admin' });
      await transfer(admin, body(victim, admin)).expect(403);
    });

    it('rejects a blocked sender with 403 USER_BLOCKED', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      await block(a.userId);

      const res = await transfer(a, body(a, b)).expect(403);
      expect(res.body.error).toEqual({ code: 'USER_BLOCKED', message: 'Your account is blocked' });
      expect(await balanceOf(a.walletId)).toBe('5000');
    });

    it('rejects a blocked receiver with 403 USER_BLOCKED', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      await block(b.userId);

      const res = await transfer(a, body(a, b)).expect(403);
      expect(res.body.error).toEqual({
        code: 'USER_BLOCKED',
        message: 'The recipient cannot receive transfers',
      });
      expect(await balanceOf(a.walletId)).toBe('5000');
    });

    it.each(['source', 'destination'])('rejects a frozen %s wallet with 422', async (which) => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const frozen = which === 'source' ? a : b;
      await pool.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [frozen.walletId]);

      const res = await transfer(a, body(a, b)).expect(422);
      expect(res.body.error.code).toBe('WALLET_FROZEN');
    });

    it('rejects different currencies with 422 CURRENCY_MISMATCH', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO wallets (user_id, currency) VALUES ($1, 'USD') RETURNING id`,
        [b.userId],
      );

      const res = await transfer(a, body(a, { ...b, walletId: rows[0].id })).expect(422);
      expect(res.body.error.code).toBe('CURRENCY_MISMATCH');
    });

    it('rejects more than the balance with 422 INSUFFICIENT_FUNDS and moves nothing', async () => {
      const a = await createUser({ funds: '999' });
      const b = await createUser();

      const res = await transfer(a, body(a, b, '1000')).expect(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(a.walletId)).toBe('999');
      expect(await balanceOf(b.walletId)).toBe('0');
      expect(await transferCount(a.walletId)).toBe(0);
    });

    it('rejects sending to the same wallet with 422 SAME_WALLET', async () => {
      const a = await createUser({ funds: '5000' });
      const res = await transfer(a, body(a, a)).expect(422);
      expect(res.body.error.code).toBe('SAME_WALLET');
    });

    it('returns 503 TRY_AGAIN when a wallet stays locked past the 5s lock timeout', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [b.walletId]);

        const res = await transfer(a, body(a, b)).expect(503);
        expect(res.body.error.code).toBe('TRY_AGAIN');
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await balanceOf(a.walletId)).toBe('5000');
    }, 15_000);

    it.each([
      ['a malformed wallet id', { sourceWalletId: 'nope' }, 'VALIDATION_ERROR'],
      ['a decimal amount', { amount: '10.50' }, 'INVALID_AMOUNT'],
      ['a zero amount', { amount: '0' }, 'INVALID_AMOUNT'],
      ['a numeric amount', { amount: 1000 }, 'VALIDATION_ERROR'],
      ['a narration over 140 chars', { narration: 'x'.repeat(141) }, 'VALIDATION_ERROR'],
      ['an initiator in the body', { initiatedBy: randomUUID() }, 'VALIDATION_ERROR'],
    ])('rejects %s with 400', async (_label, override, code) => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const res = await transfer(a, { ...body(a, b), ...override }).expect(400);
      expect(res.body.error.code).toBe(code);
      expect(await balanceOf(a.walletId)).toBe('5000');
    });

    it('requires an Idempotency-Key', async () => {
      const a = await createUser({ funds: '5000' });
      const b = await createUser();
      const res = await transfer(a, body(a, b), null).expect(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('requires a token', async () => {
      await request(app.getHttpServer()).post('/transfers').send({}).expect(401);
    });
  });
});
