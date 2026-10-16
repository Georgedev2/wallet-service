import { randomInt, randomUUID } from 'crypto';
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthUser, CurrentUser } from '../src/common/decorators/current-user.decorator';
import { AdminGuard } from '../src/common/guards/admin.guard';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';

/** Protected routes for exercising the guards; no real ones exist yet. */
@Controller('probe')
class ProbeController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  admin() {
    return { ok: true };
  }
}

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return app;
}

const PASSWORD = 'correct horse battery staple';

interface TestUser {
  id: string;
  email: string;
}

describe('auth (e2e)', () => {
  let pool: Pool;
  let alice: TestUser;
  let blocked: TestUser;
  let admin: TestUser;
  const createdIds: string[] = [];

  async function insertUser(
    opts: { role?: 'user' | 'admin'; blocked?: boolean } = {},
  ): Promise<TestUser> {
    const email = `user-${randomUUID()}@example.com`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, phone, full_name, password_hash, role, status, blocked_at)
       VALUES ($1, $2, 'Test User', $3, $4, $5, $6)
       RETURNING id`,
      [
        email,
        `+234${randomInt(1e9, 1e10)}`,
        await argon2.hash(PASSWORD),
        opts.role ?? 'user',
        opts.blocked ? 'blocked' : 'active',
        opts.blocked ? new Date() : null,
      ],
    );
    createdIds.push(rows[0].id);
    return { id: rows[0].id, email };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    alice = await insertUser();
    blocked = await insertUser({ blocked: true });
    admin = await insertUser({ role: 'admin' });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    await pool.end();
  });

  describe('POST /auth/login', () => {
    // A fresh app per test gives each one its own in-memory throttle counter.
    let app: INestApplication;

    beforeEach(async () => {
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
    });

    const login = (body: object) => request(app.getHttpServer()).post('/auth/login').send(body);

    it('returns an access token and the user', async () => {
      const res = await login({ email: alice.email, password: PASSWORD }).expect(200);

      expect(res.body.data).toEqual({
        accessToken: expect.any(String),
        user: {
          id: alice.id,
          email: alice.email,
          fullName: 'Test User',
          role: 'user',
          status: 'active',
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);

      const payload = app.get(JwtService).decode(res.body.data.accessToken);
      expect(payload).toMatchObject({ sub: alice.id, role: 'user' });

      // The token is accepted by the JWT guard and becomes request.user.
      const me = await request(app.getHttpServer())
        .get('/probe/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
      expect(me.body).toEqual({ data: { id: alice.id, role: 'user' } });
    });

    it('normalises the email (trim, lowercase)', async () => {
      const res = await login({ email: `  ${alice.email.toUpperCase()} `, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(alice.id);
    });

    it('lets a blocked user log in', async () => {
      const res = await login({ email: blocked.email, password: PASSWORD }).expect(200);
      expect(res.body.data.user.status).toBe('blocked');
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const res = await login({ email: alice.email, password: 'wrong password' }).expect(401);
      expect(res.body).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    });

    it('rejects an unknown email exactly like a wrong password', async () => {
      const unknown = await login({ email: 'nobody@example.com', password: PASSWORD }).expect(401);
      const wrongPassword = await login({ email: alice.email, password: 'nope' }).expect(401);
      expect(unknown.body).toEqual(wrongPassword.body);
    });

    it('rejects a malformed body with 400 VALIDATION_ERROR', async () => {
      const res = await login({ email: 'not-an-email' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('allows 5 attempts per minute per IP, then returns 429', async () => {
      for (let i = 0; i < 5; i++) {
        await login({ email: alice.email, password: 'wrong' }).expect(401);
      }
      const res = await login({ email: alice.email, password: PASSWORD }).expect(429);
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('guards', () => {
    let app: INestApplication;
    let jwt: JwtService;

    beforeAll(async () => {
      app = await createApp();
      jwt = app.get(JwtService);
    });

    afterAll(async () => {
      await app.close();
    });

    const get = (path: string, token?: string) => {
      const req = request(app.getHttpServer()).get(path);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    it('rejects a protected route without a token with 401', async () => {
      const res = await get('/probe/me').expect(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid access token' },
      });
    });

    it.each([
      ['malformed', () => 'not-a-jwt'],
      [
        'signed with another secret',
        () => jwt.sign({ sub: alice.id, role: 'user' }, { secret: 'x'.repeat(32) }),
      ],
      ['expired', () => jwt.sign({ sub: alice.id, role: 'user' }, { expiresIn: -60 })],
      ['carrying an unknown role', () => jwt.sign({ sub: alice.id, role: 'superuser' })],
    ])('rejects a token that is %s with 401', async (_label, token) => {
      const res = await get('/probe/me', token()).expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a non-admin on an admin route with 403 FORBIDDEN', async () => {
      const token = jwt.sign({ sub: alice.id, role: 'user' });
      const res = await get('/probe/admin', token).expect(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    });

    it('lets an admin through the admin guard', async () => {
      const token = jwt.sign({ sub: admin.id, role: 'admin' });
      const res = await get('/probe/admin', token).expect(200);
      expect(res.body).toEqual({ data: { ok: true } });
    });
  });
});
