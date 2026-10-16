import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as request from 'supertest';
import { BlacklistService } from '../src/blacklist/blacklist.service';
import { createApp } from './helpers';

/** A random Nigerian mobile number in local format, e.g. "0803 1234567". */
const localPhone = () => `0803 ${randomInt(1e6, 1e7)}`;
const toE164 = (local: string) => `+234${local.replace(/\D/g, '').slice(1)}`;
const randomBvn = () => String(randomInt(1e10, 1e11));

describe('blacklist (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let blacklist: BlacklistService;
  let adminToken: string;
  let userToken: string;
  // Entries above this id were created by this suite (e2e suites run in band).
  let maxIdBefore: string;

  beforeAll(async () => {
    app = await createApp();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const { rows } = await pool.query('SELECT coalesce(max(id), 0) AS id FROM blacklist_entries');
    maxIdBefore = rows[0].id;
    blacklist = app.get(BlacklistService);
    // The guards trust the JWT alone, so the subjects don't need to exist as users.
    const jwt = app.get(JwtService);
    adminToken = jwt.sign({ sub: randomUUID(), role: 'admin' });
    userToken = jwt.sign({ sub: randomUUID(), role: 'user' });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM blacklist_entries WHERE id > $1', [maxIdBefore]);
    await app.close();
    await pool.end();
  });

  const post = (token: string | null, body: object) => {
    const req = request(app.getHttpServer()).post('/admin/blacklist').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const del = (token: string, id: string) =>
    request(app.getHttpServer())
      .delete(`/admin/blacklist/${id}`)
      .set('Authorization', `Bearer ${token}`);

  const count = async (value: string) =>
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM blacklist_entries WHERE identity_value = $1',
        [value],
      )
    ).rows[0].n;

  describe('POST /admin/blacklist', () => {
    it('lets an admin add an entry, stored normalised', async () => {
      const phone = localPhone();
      const res = await post(adminToken, {
        identityType: 'phone',
        identityValue: phone,
        reason: 'Fraud report #42',
      }).expect(201);

      expect(res.body.data).toEqual({
        id: expect.stringMatching(/^\d+$/),
        identityType: 'phone',
        identityValue: toE164(phone),
        reason: 'Fraud report #42',
        source: 'internal',
        createdAt: expect.any(String),
      });
    });

    it('rejects a non-admin with 403 FORBIDDEN and stores nothing', async () => {
      const phone = localPhone();
      const res = await post(userToken, {
        identityType: 'phone',
        identityValue: phone,
        reason: 'x',
      }).expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await count(toE164(phone))).toBe(0);
    });

    it('rejects a request without a token with 401', async () => {
      await post(null, { identityType: 'phone', identityValue: localPhone(), reason: 'x' }).expect(
        401,
      );
    });

    it('rejects the same identity in another format with 409 ALREADY_BLACKLISTED', async () => {
      const phone = localPhone();
      await post(adminToken, { identityType: 'phone', identityValue: phone, reason: 'x' }).expect(
        201,
      );
      const res = await post(adminToken, {
        identityType: 'phone',
        identityValue: toE164(phone),
        reason: 'again',
      }).expect(409);

      expect(res.body.error.code).toBe('ALREADY_BLACKLISTED');
    });

    it.each([
      [
        'an unknown identity type',
        { identityType: 'passport', identityValue: 'A1', reason: 'x' },
        'VALIDATION_ERROR',
      ],
      [
        'a missing reason',
        { identityType: 'bvn', identityValue: '22345678901' },
        'VALIDATION_ERROR',
      ],
      [
        'an invalid phone',
        { identityType: 'phone', identityValue: '12345', reason: 'x' },
        'INVALID_PHONE',
      ],
      [
        'an invalid email',
        { identityType: 'email', identityValue: 'nope', reason: 'x' },
        'INVALID_EMAIL',
      ],
      ['an invalid BVN', { identityType: 'bvn', identityValue: '123', reason: 'x' }, 'INVALID_BVN'],
    ])('rejects %s with 400', async (_label, body, code) => {
      const res = await post(adminToken, body).expect(400);
      expect(res.body.error.code).toBe(code);
    });
  });

  describe('DELETE /admin/blacklist/:id', () => {
    it('lets an admin remove an entry, then 404s', async () => {
      const created = await post(adminToken, {
        identityType: 'bvn',
        identityValue: randomBvn(),
        reason: 'x',
      }).expect(201);
      const { id, identityValue } = created.body.data;

      await del(adminToken, id).expect(204);
      expect(await count(identityValue)).toBe(0);

      const res = await del(adminToken, id).expect(404);
      expect(res.body.error.code).toBe('BLACKLIST_ENTRY_NOT_FOUND');
    });

    it('rejects a non-admin with 403 and keeps the entry', async () => {
      const created = await post(adminToken, {
        identityType: 'bvn',
        identityValue: randomBvn(),
        reason: 'x',
      }).expect(201);

      await del(userToken, created.body.data.id).expect(403);
      expect(await count(created.body.data.identityValue)).toBe(1);
    });

    it.each(['abc', '0', '-1', '1'.repeat(19)])('rejects id %p with 400', async (id) => {
      const res = await del(adminToken, id).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('BlacklistService.isBlacklisted', () => {
    const clean = () => ({
      email: `clean-${randomUUID()}@example.com`,
      phone: localPhone(),
      bvn: randomBvn(),
    });

    it('is false when nothing matches', async () => {
      expect(await blacklist.isBlacklisted(clean())).toBe(false);
    });

    it('matches on any one identity, after normalising the input', async () => {
      const email = `bad-${randomUUID()}@example.com`;
      const phone = localPhone();
      const bvn = randomBvn();
      await post(adminToken, { identityType: 'email', identityValue: email, reason: 'x' }).expect(
        201,
      );
      await post(adminToken, { identityType: 'phone', identityValue: phone, reason: 'x' }).expect(
        201,
      );
      await post(adminToken, { identityType: 'bvn', identityValue: bvn, reason: 'x' }).expect(201);

      expect(
        await blacklist.isBlacklisted({ ...clean(), email: `  ${email.toUpperCase()} ` }),
      ).toBe(true);
      expect(await blacklist.isBlacklisted({ ...clean(), phone: toE164(phone) })).toBe(true);
      expect(
        await blacklist.isBlacklisted({ ...clean(), bvn: `${bvn.slice(0, 4)}-${bvn.slice(4)}` }),
      ).toBe(true);
    });

    it('ignores BVN entries when no BVN is given', async () => {
      const bvn = randomBvn();
      await post(adminToken, { identityType: 'bvn', identityValue: bvn, reason: 'x' }).expect(201);
      const { email, phone } = clean();
      expect(await blacklist.isBlacklisted({ email, phone })).toBe(false);
    });
  });
});
