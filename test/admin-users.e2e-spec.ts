import { randomInt, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import * as request from 'supertest';
import { createApp } from './helpers';

const PASSWORD = 'correct horse battery staple';

describe('admin users: block / unblock (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  let passwordHash: string;
  let adminId: string;
  let adminToken: string;
  const createdIds: string[] = [];

  async function insertUser(role: 'user' | 'admin' = 'user', bvn: string | null = null) {
    const email = `user-${randomUUID()}@example.com`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role, bvn)
       VALUES ($1, $2, 'Test User', $3, $4, $5) RETURNING id`,
      [email, `+234${randomInt(1e9, 1e10)}`, passwordHash, role, bvn],
    );
    createdIds.push(rows[0].id);
    return { id: rows[0].id, email };
  }

  const tokenFor = (id: string, role: 'user' | 'admin' = 'user') => jwt.sign({ sub: id, role });

  const patch = (path: string, body: object, token = adminToken) =>
    request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);

  const history = (id: string, token = adminToken) =>
    request(app.getHttpServer())
      .get(`/admin/users/${id}/status-history`)
      .set('Authorization', `Bearer ${token}`);

  async function eventCount(userId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM user_status_events WHERE user_id = $1',
      [userId],
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    app = await createApp();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    jwt = app.get(JwtService);
    passwordHash = await argon2.hash(PASSWORD);
    adminId = (await insertUser('admin')).id;
    adminToken = tokenFor(adminId, 'admin');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM user_status_events WHERE user_id = ANY($1::uuid[])', [
      createdIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    await pool.end();
    await app.close();
  });

  it('blocks then unblocks a user, writing 2 audit rows', async () => {
    const { id } = await insertUser();

    const blocked = await patch(`/admin/users/${id}/block`, { reason: 'Chargeback fraud' }).expect(
      200,
    );
    expect(blocked.body.data).toMatchObject({
      id,
      status: 'blocked',
      blockedReason: 'Chargeback fraud',
      blockedAt: expect.any(String),
    });

    const unblocked = await patch(`/admin/users/${id}/unblock`, { reason: 'Cleared' }).expect(200);
    expect(unblocked.body.data).toMatchObject({
      id,
      status: 'active',
      blockedReason: null,
      blockedAt: null,
    });

    expect(await eventCount(id)).toBe(2);
  });

  it('returns the status history newest first, with the acting admin', async () => {
    const { id } = await insertUser();
    await patch(`/admin/users/${id}/block`, { reason: 'first' }).expect(200);
    await patch(`/admin/users/${id}/unblock`, { reason: 'second' }).expect(200);
    await patch(`/admin/users/${id}/block`, { reason: 'third' }).expect(200);

    const res = await history(id).expect(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ action: 'blocked', reason: 'third', performedBy: adminId }),
      expect.objectContaining({ action: 'unblocked', reason: 'second', performedBy: adminId }),
      expect.objectContaining({ action: 'blocked', reason: 'first', performedBy: adminId }),
    ]);
    expect(res.body.data[0]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      action: 'blocked',
      reason: 'third',
      performedBy: adminId,
      createdAt: expect.any(String),
    });
  });

  it('lets a blocked user log in and GET /users/me', async () => {
    const user = await insertUser();
    await patch(`/admin/users/${user.id}/block`, { reason: 'Under review' }).expect(200);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200);

    expect(me.body.data.user).toMatchObject({ status: 'blocked', blockedReason: 'Under review' });
  });

  it('never returns the password hash or the full BVN', async () => {
    const bvn = String(randomInt(1e10, 1e11));
    const { id } = await insertUser('user', bvn);

    const res = await patch(`/admin/users/${id}/block`, { reason: 'x' }).expect(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/password/i);
    expect(json).not.toContain(bvn);
    expect(res.body.data.bvn).toBe(`*******${bvn.slice(-4)}`);
  });

  it('rejects blocking an already-blocked user with 409 ALREADY_BLOCKED', async () => {
    const { id } = await insertUser();
    await patch(`/admin/users/${id}/block`, { reason: 'x' }).expect(200);

    const res = await patch(`/admin/users/${id}/block`, { reason: 'again' }).expect(409);
    expect(res.body.error.code).toBe('ALREADY_BLOCKED');
    expect(await eventCount(id)).toBe(1);
  });

  it('rejects unblocking an active user with 409 NOT_BLOCKED', async () => {
    const { id } = await insertUser();
    const res = await patch(`/admin/users/${id}/unblock`, { reason: 'x' }).expect(409);
    expect(res.body.error.code).toBe('NOT_BLOCKED');
    expect(await eventCount(id)).toBe(0);
  });

  it('records exactly one block when two admins block at the same time', async () => {
    const { id } = await insertUser();
    const results = await Promise.all([
      patch(`/admin/users/${id}/block`, { reason: 'a' }),
      patch(`/admin/users/${id}/block`, { reason: 'b' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await eventCount(id)).toBe(1);
  });

  it('stops an admin blocking themselves with 422 CANNOT_BLOCK_SELF', async () => {
    const res = await patch(`/admin/users/${adminId}/block`, { reason: 'x' }).expect(422);
    expect(res.body.error.code).toBe('CANNOT_BLOCK_SELF');
    expect(await eventCount(adminId)).toBe(0);
  });

  it('rejects a non-admin with 403 and changes nothing', async () => {
    const target = await insertUser();
    const caller = await insertUser();
    const token = tokenFor(caller.id);

    await patch(`/admin/users/${target.id}/block`, { reason: 'x' }, token).expect(403);
    await patch(`/admin/users/${target.id}/unblock`, { reason: 'x' }, token).expect(403);
    await history(target.id, token).expect(403);
    expect(await eventCount(target.id)).toBe(0);
  });

  it.each([
    ['block', (id: string) => patch(`/admin/users/${id}/block`, { reason: 'x' })],
    ['unblock', (id: string) => patch(`/admin/users/${id}/unblock`, { reason: 'x' })],
    ['status-history', (id: string) => history(id)],
  ])('returns 404 USER_NOT_FOUND for an unknown id (%s)', async (_label, call) => {
    const res = await call(randomUUID()).expect(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('rejects a malformed id with 400', async () => {
    const res = await patch('/admin/users/not-a-uuid/block', { reason: 'x' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['missing', {}],
    ['blank', { reason: '   ' }],
    ['too long', { reason: 'x'.repeat(501) }],
  ])('rejects a %s reason with 400', async (_label, body) => {
    const { id } = await insertUser();
    await patch(`/admin/users/${id}/block`, body).expect(400);
    expect(await eventCount(id)).toBe(0);
  });
});
