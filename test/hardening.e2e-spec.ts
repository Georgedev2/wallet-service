import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { createApp } from './helpers';
import { MoneyKit } from './money-kit';

const ALLOWED_ORIGIN = 'https://allowed.example.com'; // set in setup-env.ts

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Hardening (e2e)', () => {
  describe('HTTP pipeline', () => {
    let app: INestApplication;
    let pool: Pool;
    const userIds: string[] = [];

    beforeAll(async () => {
      app = await createApp();
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    });

    afterAll(async () => {
      await pool.query('DELETE FROM user_status_events WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM wallets WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      await pool.end();
      await app.close();
    });

    const http = () => request(app.getHttpServer());

    describe('CORS', () => {
      it('allows an origin listed in CORS_ORIGINS, including the custom headers', async () => {
        const res = await http()
          .options('/transfers')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
          .expect(204);
        expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
        expect(res.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/);
      });

      it('gives other origins no CORS headers, so browsers block the response', async () => {
        const res = await http().get('/').set('Origin', 'https://evil.example.com').expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
    });

    describe('body size limit', () => {
      it('rejects a JSON body over 10kb with 413 and the error shape', async () => {
        const res = await http()
          .post('/auth/login')
          .send({ email: 'a@example.com', password: 'x'.repeat(11 * 1024) })
          .expect(413);
        expect(res.body).toEqual({
          error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) },
        });
      });

      it('accepts a body under the limit (it reaches validation)', async () => {
        const res = await http()
          .post('/auth/login')
          .send({ email: 'a@example.com', password: 'x'.repeat(9 * 1024) })
          .expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    it('never returns a full BVN: signup, login, /users/me, block and unblock', async () => {
      const bvn = `2${randomInt(1e9, 1e10)}`;
      const password = 'Passw0rd!Test';
      const email = `bvn-${randomUUID()}@example.com`;

      const signup = await http()
        .post('/users')
        .send({ email, phone: `+234803${randomInt(1e6, 1e7)}`, fullName: 'B V N', password, bvn })
        .expect(201);
      const userId: string = signup.body.data.user.id;
      userIds.push(userId);
      expect(signup.body.data.user.bvn).toBe(`*******${bvn.slice(-4)}`);

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, phone, full_name, password_hash, role)
         VALUES ($1, $2, 'Admin', 'not-a-real-hash', 'admin') RETURNING id`,
        [`admin-${randomUUID()}@example.com`, `+234${randomInt(1e9, 1e10)}`],
      );
      userIds.push(rows[0].id);
      const adminToken = app.get(JwtService).sign({ sub: rows[0].id, role: 'admin' });

      const login = await http().post('/auth/login').send({ email, password }).expect(200);
      const userToken: string = login.body.data.accessToken;
      const responses = [
        signup,
        login,
        await http().get('/users/me').set('Authorization', `Bearer ${userToken}`).expect(200),
        await http()
          .patch(`/admin/users/${userId}/block`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ reason: 'test' })
          .expect(200),
        await http()
          .patch(`/admin/users/${userId}/unblock`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ reason: 'test' })
          .expect(200),
      ];
      for (const res of responses) {
        expect(res.text).not.toContain(bvn);
      }
    });
  });

  describe('global rate limit', () => {
    let app: INestApplication;
    const saved = process.env.RATE_LIMIT_PER_MINUTE;

    beforeAll(async () => {
      process.env.RATE_LIMIT_PER_MINUTE = '3';
      // ConfigModule validates the env when AppModule is loaded, so load a fresh copy.
      jest.resetModules();
      const helpers = await import('./helpers');
      app = await helpers.createApp();
    });

    afterAll(async () => {
      await app.close();
      process.env.RATE_LIMIT_PER_MINUTE = saved;
    });

    it('limits every route per IP, not only login and signup', async () => {
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer()).get('/').expect(200);
      }
      const res = await request(app.getHttpServer()).get('/').expect(429);
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('graceful shutdown', () => {
    let kit: MoneyKit;

    beforeAll(async () => {
      kit = await MoneyKit.start();
    });

    afterAll(async () => {
      await kit.stop();
    });

    it('stops accepting connections, finishes in-flight requests, then closes the pool', async () => {
      const a = await kit.createUser('1000');
      const b = await kit.createUser();
      // By URL: supertest would re-listen on a closed server object.
      const url = await kit.app.getUrl();
      const server = kit.app.getHttpServer();

      // Hold Alice's wallet lock so her transfer is still running when shutdown starts.
      const locker = await kit.pool.connect();
      let committed = false;
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [a.walletId]);

        const inFlight = request(url)
          .post('/transfers')
          .set('Authorization', `Bearer ${a.token}`)
          .set('Idempotency-Key', `key-${randomUUID()}`)
          .send({ sourceWalletId: a.walletId, destinationWalletId: b.walletId, amount: '100' })
          .then((res) => res);
        await waitFor(async () => {
          const { rows } = await kit.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return rows[0].n > 0;
        });

        const closing = kit.closeApp();
        await waitFor(() => !server.listening);
        await expect(
          request(url).get('/users/me').set('Authorization', `Bearer ${b.token}`),
        ).rejects.toThrow(/ECONNREFUSED/);

        await locker.query('COMMIT');
        committed = true;
        expect((await inFlight).status).toBe(201);
        await closing;
      } finally {
        if (!committed) {
          await locker.query('ROLLBACK');
        }
        locker.release();
      }
      expect(await kit.balanceOf(b.walletId)).toBe('100');
      await kit.expectReconciled();
    });
  });
});
