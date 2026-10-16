import { randomInt, randomUUID } from 'crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as request from 'supertest';
import { WalletsRepository } from '../src/wallets/wallets.repository';
import { createApp } from './helpers';

const PASSWORD = 'correct horse battery staple';

/** A random Nigerian mobile number in local format, e.g. "08031234567". */
const localPhone = () => `0803${randomInt(1e6, 1e7)}`;
const toE164 = (local: string) => `+234${local.slice(1)}`;
const randomBvn = () => String(randomInt(1e10, 1e11));

describe('users (e2e)', () => {
  let pool: Pool;
  let app: INestApplication;
  const emails: string[] = [];
  const blacklistIds: string[] = [];

  /** A valid signup body with a unique email and phone. */
  const newSignup = () => {
    const email = `user-${randomUUID()}@example.com`;
    emails.push(email);
    return { email, phone: localPhone(), fullName: 'Ada Lovelace', password: PASSWORD };
  };

  const signup = (body: object) => request(app.getHttpServer()).post('/users').send(body);

  async function blacklist(type: string, value: string): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO blacklist_entries (identity_type, identity_value, reason)
       VALUES ($1, $2, 'test') RETURNING id`,
      [type, value],
    );
    blacklistIds.push(rows[0].id);
  }

  async function walletCount(userId: string): Promise<number> {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM wallets WHERE user_id = $1', [
      userId,
    ]);
    return rows[0].n;
  }

  async function userCount(email: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return rows[0].n;
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  });

  // A fresh app per test gives each one its own in-memory throttle counter.
  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM wallets WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))`,
      [emails],
    );
    await pool.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
    await pool.query('DELETE FROM blacklist_entries WHERE id = ANY($1::bigint[])', [blacklistIds]);
    await pool.end();
  });

  describe('POST /users', () => {
    it('creates the user and exactly one NGN wallet', async () => {
      const body = newSignup();
      const res = await signup(body).expect(201);

      expect(res.body.data).toEqual({
        user: {
          id: expect.any(String),
          email: body.email,
          phone: toE164(body.phone),
          fullName: 'Ada Lovelace',
          bvn: null,
          role: 'user',
          status: 'active',
          createdAt: expect.any(String),
        },
        wallet: { id: expect.any(String), currency: 'NGN', balance: '0' },
      });
      expect(await walletCount(res.body.data.user.id)).toBe(1);
    });

    it('never returns the password or its hash', async () => {
      const res = await signup(newSignup()).expect(201);
      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/password/i);
      expect(json).not.toContain('$argon2');
    });

    it('stores an argon2 hash, not the password', async () => {
      const body = newSignup();
      await signup(body).expect(201);
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [
        body.email,
      ]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    });

    it('normalises the email, and the new user can log in', async () => {
      const body = newSignup();
      const res = await signup({ ...body, email: `  ${body.email.toUpperCase()} ` }).expect(201);
      expect(res.body.data.user.email).toBe(body.email);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: body.email, password: PASSWORD })
        .expect(200);
    });

    it('rolls back the user if the wallet insert fails', async () => {
      // The database stays real; only the wallet step is made to fail.
      jest
        .spyOn(app.get(WalletsRepository), 'insert')
        .mockRejectedValueOnce(new Error('wallet insert failed'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const body = newSignup();

      await signup(body).expect(500);
      expect(await userCount(body.email)).toBe(0);
      jest.restoreAllMocks();
    });

    it('rejects a duplicate email, case-insensitively, with 409 USER_EXISTS', async () => {
      const first = newSignup();
      await signup(first).expect(201);

      const res = await signup({ ...newSignup(), email: first.email.toUpperCase() }).expect(409);
      expect(res.body).toEqual({
        error: {
          code: 'USER_EXISTS',
          message: 'An account with this email, phone number or BVN already exists',
        },
      });
      expect(await userCount(first.email)).toBe(1);
    });

    it('rejects a duplicate phone in another format with 409 USER_EXISTS', async () => {
      const first = newSignup();
      await signup(first).expect(201);

      const res = await signup({ ...newSignup(), phone: toE164(first.phone) }).expect(409);
      expect(res.body.error.code).toBe('USER_EXISTS');
    });

    it('stores the BVN normalised and returns it masked', async () => {
      const bvn = randomBvn();
      const body = { ...newSignup(), bvn: `${bvn.slice(0, 4)}-${bvn.slice(4)}` };
      const res = await signup(body).expect(201);

      expect(res.body.data.user.bvn).toBe(`*******${bvn.slice(-4)}`);
      expect(JSON.stringify(res.body)).not.toContain(bvn);
      const { rows } = await pool.query('SELECT bvn FROM users WHERE email = $1', [body.email]);
      expect(rows[0].bvn).toBe(bvn);
    });

    it('rejects a BVN already used by another account with 409 USER_EXISTS', async () => {
      const bvn = randomBvn();
      await signup({ ...newSignup(), bvn }).expect(201);

      const res = await signup({ ...newSignup(), bvn }).expect(409);
      expect(res.body.error.code).toBe('USER_EXISTS');
    });

    it('rejects a blacklisted phone given in 0-prefixed format with 403', async () => {
      const body = newSignup();
      await blacklist('phone', toE164(body.phone));

      const res = await signup(body).expect(403);
      expect(res.body).toEqual({
        error: { code: 'USER_BLACKLISTED', message: 'Unable to create account' },
      });
      expect(await userCount(body.email)).toBe(0);
    });

    it('gives the same 403 for a blacklisted email or BVN, without naming the match', async () => {
      const byEmail = newSignup();
      await blacklist('email', byEmail.email);
      const bvn = randomBvn();
      await blacklist('bvn', bvn);

      const emailRes = await signup(byEmail).expect(403);
      const bvnRes = await signup({ ...newSignup(), bvn }).expect(403);
      expect(emailRes.body).toEqual(bvnRes.body);
    });

    it.each([
      ['a weak (7-char) password', { password: 'short12' }, 'VALIDATION_ERROR'],
      ['a missing full name', { fullName: '  ' }, 'VALIDATION_ERROR'],
      ['an invalid email', { email: 'not-an-email' }, 'VALIDATION_ERROR'],
      ['an unknown field', { role: 'admin' }, 'VALIDATION_ERROR'],
      ['an invalid phone', { phone: '12345' }, 'INVALID_PHONE'],
      ['an invalid BVN', { bvn: '123' }, 'INVALID_BVN'],
    ])('rejects %s with 400', async (_label, override, code) => {
      const body = { ...newSignup(), ...override };
      const res = await signup(body).expect(400);
      expect(res.body.error.code).toBe(code);
      expect(await userCount(body.email)).toBe(0);
    });

    it('allows 10 signups per minute per IP, then returns 429', async () => {
      for (let i = 0; i < 10; i++) {
        await signup({ ...newSignup(), password: 'short' }).expect(400);
      }
      await signup(newSignup()).expect(429);
    });
  });

  describe('GET /users/me', () => {
    it('returns the current user (BVN masked) and their wallets', async () => {
      const bvn = randomBvn();
      const body = { ...newSignup(), bvn };
      const created = await signup(body).expect(201);
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: body.email, password: PASSWORD })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        user: created.body.data.user,
        wallets: [created.body.data.wallet],
      });
      expect(res.body.data.user.bvn).toBe(`*******${bvn.slice(-4)}`);
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    it('rejects a request without a token with 401', async () => {
      await request(app.getHttpServer()).get('/users/me').expect(401);
    });
  });
});
