import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { createApp } from './helpers';

describe('wallets and funding (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  let adminId: string;
  let adminToken: string;
  const userIds: string[] = [];

  /** A user with an NGN wallet, inserted directly. */
  async function createUser(role: 'user' | 'admin' = 'user') {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role)
       VALUES ($1, $2, 'Test User', 'not-a-real-hash', $3) RETURNING id`,
      [`user-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`, role],
    );
    const userId = rows[0].id;
    userIds.push(userId);
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO wallets (user_id) VALUES ($1) RETURNING id`,
      [userId],
    );
    return { userId, walletId: wallet.rows[0].id, token: jwt.sign({ sub: userId, role }) };
  }

  const key = () => `key-${randomUUID()}`;

  const fund = (walletId: string, body: object, idemKey: string | null = key()) => {
    const req = request(app.getHttpServer())
      .post(`/admin/wallets/${walletId}/fund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
    return idemKey ? req.set('Idempotency-Key', idemKey) : req;
  };

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  async function balanceOf(walletId: string): Promise<string> {
    const { rows } = await pool.query('SELECT balance::text AS b FROM wallets WHERE id = $1', [
      walletId,
    ]);
    return rows[0].b;
  }

  async function transactionCount(walletId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE destination_wallet_id = $1',
      [walletId],
    );
    return rows[0].n;
  }

  /** CLAUDE.md rule 5: the balance always equals the sum of the wallet's ledger entries. */
  async function expectReconciled(walletId: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT w.balance::text AS balance,
              COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0)::text
                AS ledger
         FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = $1
        GROUP BY w.id`,
      [walletId],
    );
    expect(rows[0].balance).toBe(rows[0].ledger);
  }

  beforeAll(async () => {
    app = await createApp();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    jwt = app.get(JwtService);
    const admin = await createUser('admin');
    adminId = admin.userId;
    adminToken = admin.token;
  });

  afterAll(async () => {
    const wallets = `SELECT id FROM wallets WHERE user_id = ANY($1::uuid[])`;
    await pool.query(`DELETE FROM ledger_entries WHERE wallet_id IN (${wallets})`, [userIds]);
    await pool.query(
      `DELETE FROM transactions WHERE destination_wallet_id IN (${wallets})
          OR initiated_by = ANY($1::uuid[])`,
      [userIds],
    );
    await pool.query(`DELETE FROM wallets WHERE user_id = ANY($1::uuid[])`, [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
    await app.close();
  });

  describe('POST /admin/wallets/:id/fund', () => {
    it('credits the wallet and records it in the history', async () => {
      const { walletId, token } = await createUser();

      const res = await fund(walletId, { amount: '150000', narration: 'Opening balance' }).expect(
        201,
      );
      expect(res.body.data).toEqual({
        reference: expect.stringMatching(/^FND-[0-9A-F]{16}$/),
        type: 'funding',
        walletId,
        amount: '150000',
        currency: 'NGN',
        narration: 'Opening balance',
        status: 'completed',
        balanceAfter: '150000',
        createdAt: expect.any(String),
        replayed: false,
      });
      expect(await balanceOf(walletId)).toBe('150000');
      const { rows } = await pool.query(
        'SELECT initiated_by, source_wallet_id FROM transactions WHERE reference = $1',
        [res.body.data.reference],
      );
      expect(rows[0]).toEqual({ initiated_by: adminId, source_wallet_id: null });

      const history = await get(`/wallets/${walletId}/transactions`, token).expect(200);
      expect(history.body.data).toEqual({
        items: [
          {
            reference: res.body.data.reference,
            type: 'funding',
            direction: 'credit',
            amount: '150000',
            balanceAfter: '150000',
            counterpartyWalletId: null,
            narration: 'Opening balance',
            createdAt: expect.any(String),
          },
        ],
        nextCursor: null,
      });
      await expectReconciled(walletId);
    });

    it('replays the same key with 200, the same body, and no double credit', async () => {
      const { walletId } = await createUser();
      const k = key();

      const first = await fund(walletId, { amount: '5000' }, k).expect(201);
      const second = await fund(walletId, { amount: '5000' }, k).expect(200);

      expect(second.body.data).toEqual({ ...first.body.data, replayed: true });
      expect(await balanceOf(walletId)).toBe('5000');
      expect(await transactionCount(walletId)).toBe(1);
      await expectReconciled(walletId);
    });

    it('credits once when the same request is sent 10 times in parallel', async () => {
      const { walletId } = await createUser();
      const k = key();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => fund(walletId, { amount: '700' }, k)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.data.reference)).size).toBe(1);
      expect(await balanceOf(walletId)).toBe('700');
      await expectReconciled(walletId);
    });

    it.each([
      ['a different amount', { amount: '9999' }],
      ['a different narration', { amount: '5000', narration: 'changed' }],
    ])('rejects the same key with %s with 409 IDEMPOTENCY_KEY_REUSED', async (_label, body) => {
      const { walletId } = await createUser();
      const k = key();
      await fund(walletId, { amount: '5000' }, k).expect(201);

      const res = await fund(walletId, body, k).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(walletId)).toBe('5000');
    });

    it('rejects the same key on another wallet with 409', async () => {
      const a = await createUser();
      const b = await createUser();
      const k = key();
      await fund(a.walletId, { amount: '5000' }, k).expect(201);

      await fund(b.walletId, { amount: '5000' }, k).expect(409);
      expect(await balanceOf(b.walletId)).toBe('0');
    });

    it('rejects a wallet whose owner is blocked with 422 USER_BLOCKED', async () => {
      const { userId, walletId } = await createUser();
      await pool.query(`UPDATE users SET status = 'blocked', blocked_at = now() WHERE id = $1`, [
        userId,
      ]);

      const res = await fund(walletId, { amount: '100' }).expect(422);
      expect(res.body.error.code).toBe('USER_BLOCKED');
      expect(await transactionCount(walletId)).toBe(0);
    });

    it('rejects a frozen wallet with 422 WALLET_FROZEN', async () => {
      const { walletId } = await createUser();
      await pool.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [walletId]);

      const res = await fund(walletId, { amount: '100' }).expect(422);
      expect(res.body.error.code).toBe('WALLET_FROZEN');
    });

    it('returns 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
      const res = await fund(randomUUID(), { amount: '100' }).expect(404);
      expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it.each([
      ['a decimal', '100.50'],
      ['zero', '0'],
      ['a negative', '-100'],
      ['a number, not a string', 100],
    ])('rejects %s amount with 400', async (_label, amount) => {
      const { walletId } = await createUser();
      await fund(walletId, { amount }).expect(400);
      expect(await balanceOf(walletId)).toBe('0');
    });

    it('requires an Idempotency-Key', async () => {
      const { walletId } = await createUser();
      const res = await fund(walletId, { amount: '100' }, null).expect(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('rejects a non-admin with 403', async () => {
      const { walletId, token } = await createUser();
      await request(app.getHttpServer())
        .post(`/admin/wallets/${walletId}/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key())
        .send({ amount: '100' })
        .expect(403);
      expect(await balanceOf(walletId)).toBe('0');
    });
  });

  describe('GET /wallets/:id', () => {
    it('returns the balance as kobo and formatted', async () => {
      const { userId, walletId, token } = await createUser();
      await fund(walletId, { amount: '150050' }).expect(201);

      const res = await get(`/wallets/${walletId}`, token).expect(200);
      expect(res.body.data).toEqual({
        id: walletId,
        userId,
        currency: 'NGN',
        balance: '150050',
        balanceFormatted: '1500.50',
        status: 'active',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('lets an admin view any wallet', async () => {
      const { walletId } = await createUser();
      await get(`/wallets/${walletId}`, adminToken).expect(200);
    });

    it("returns 404 for another user's wallet, the same as a missing one", async () => {
      const owner = await createUser();
      const other = await createUser();

      const theirs = await get(`/wallets/${owner.walletId}`, other.token).expect(404);
      const missing = await get(`/wallets/${randomUUID()}`, other.token).expect(404);
      expect(theirs.body).toEqual(missing.body);
      await get(`/wallets/${owner.walletId}/transactions`, other.token).expect(404);
    });

    it('rejects a malformed id with 400 and no token with 401', async () => {
      const { token } = await createUser();
      await get('/wallets/not-a-uuid', token).expect(400);
      await request(app.getHttpServer()).get(`/wallets/${randomUUID()}`).expect(401);
    });
  });

  describe('GET /wallets/:id/transactions', () => {
    it('returns stable, non-overlapping pages, even when new entries arrive', async () => {
      const { walletId, token } = await createUser();
      for (let i = 1; i <= 5; i++) {
        await fund(walletId, { amount: String(i * 100) }).expect(201);
      }

      const page = (cursor?: string) =>
        get(
          `/wallets/${walletId}/transactions?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          token,
        ).expect(200);

      const p1 = await page();
      // A new funding between pages must not shift or repeat what follows.
      await fund(walletId, { amount: '999' }).expect(201);
      const p2 = await page(p1.body.data.nextCursor);
      const p3 = await page(p2.body.data.nextCursor);

      const amounts = [p1, p2, p3].map((p) =>
        p.body.data.items.map((i: { amount: string }) => i.amount),
      );
      expect(amounts).toEqual([['500', '400'], ['300', '200'], ['100']]);
      expect(p3.body.data.nextCursor).toBeNull();

      const refs = [p1, p2, p3].flatMap((p) =>
        p.body.data.items.map((i: { reference: string }) => i.reference),
      );
      expect(new Set(refs).size).toBe(5);
    });

    it.each([
      ['limit=0', 'limit=0'],
      ['limit=101', 'limit=101'],
      ['limit=abc', 'limit=abc'],
      ['a malformed cursor', 'cursor=abc'],
    ])('rejects %s with 400', async (_label, qs) => {
      const { walletId, token } = await createUser();
      await get(`/wallets/${walletId}/transactions?${qs}`, token).expect(400);
    });
  });
});
