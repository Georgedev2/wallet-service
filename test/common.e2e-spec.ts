import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import { Pool } from 'pg';
import * as request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AuthUser, CurrentUser } from '../src/common/decorators/current-user.decorator';
import { IdempotencyKey } from '../src/common/decorators/idempotency-key.decorator';
import { BusinessRuleError, NotFoundError } from '../src/common/errors/domain.error';

class CreateThingDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  count!: number;
}

/** Stands in for the JWT guard: sets request.user with an extra field the decorator must drop. */
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = { id: 'user-1', role: 'admin', email: 'x@y.z' };
    return true;
  }
}

@Controller('t')
class TestController {
  constructor(private readonly pool: Pool) {}

  @Get('ok')
  ok() {
    return { hello: 'world' };
  }

  @Get('not-found')
  notFound() {
    throw new NotFoundError('THING_NOT_FOUND', 'Thing not found');
  }

  @Get('rule')
  rule() {
    throw new BusinessRuleError('INSUFFICIENT_FUNDS', 'Insufficient funds');
  }

  @Get('boom')
  boom() {
    throw new Error('secret internal detail');
  }

  @Get('unique')
  async unique() {
    // Raises a real Postgres unique_violation (SQLSTATE 23505).
    await this.pool.query(
      'DO $$ BEGIN RAISE unique_violation USING CONSTRAINT = $c$users_email_uq$c$; END $$',
    );
  }

  @Post('things')
  create(@Body() dto: CreateThingDto) {
    return { name: dto.name, count: dto.count, isDto: dto instanceof CreateThingDto };
  }

  @Post('idem')
  idem(@IdempotencyKey() key: string) {
    return { key };
  }

  @Get('me')
  @UseGuards(FakeAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('me-unguarded')
  meUnguarded(@CurrentUser() user: AuthUser) {
    return user;
  }
}

describe('common HTTP pipeline (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [{ provide: Pool, useValue: pool }],
    }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }));
    await app.init();
  });

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const http = () => request(app.getHttpServer());

  it('wraps successful responses in { data }', async () => {
    const res = await http().get('/t/ok').expect(200);
    expect(res.body).toEqual({ data: { hello: 'world' } });
  });

  it('sets helmet security headers', async () => {
    const res = await http().get('/t/ok');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it.each([
    ['/t/not-found', 404, 'THING_NOT_FOUND', 'Thing not found'],
    ['/t/rule', 422, 'INSUFFICIENT_FUNDS', 'Insufficient funds'],
  ])('maps DomainError %s to %i', async (path, status, code, message) => {
    const res = await http().get(path).expect(status);
    expect(res.body).toEqual({ error: { code, message } });
  });

  it('maps unknown errors to 500 without leaking details, and logs them', async () => {
    const res = await http().get('/t/boom').expect(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(errorLog).toHaveBeenCalledWith(
      'secret internal detail',
      expect.stringContaining('Error'),
    );
  });

  it('maps a Postgres unique violation to 409 without naming the constraint', async () => {
    const res = await http().get('/t/unique').expect(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
  });

  it('maps unknown routes to 404 NOT_FOUND', async () => {
    const res = await http().get('/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  describe('validation', () => {
    it('transforms a valid body into the DTO class', async () => {
      const res = await http().post('/t/things').send({ name: 'a', count: 2 }).expect(201);
      expect(res.body).toEqual({ data: { name: 'a', count: 2, isDto: true } });
    });

    it('rejects unknown fields', async () => {
      const res = await http()
        .post('/t/things')
        .send({ name: 'a', count: 2, role: 'admin' })
        .expect(400);
      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'property role should not exist',
      });
    });

    it('joins every failed constraint into one message', async () => {
      const res = await http().post('/t/things').send({ count: 0 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('name must be a string');
      expect(res.body.error.message).toContain('count must not be less than 1');
    });

    it('rejects malformed JSON with the error shape', async () => {
      const res = await http()
        .post('/t/things')
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('@IdempotencyKey()', () => {
    it('returns a valid key', async () => {
      const res = await http().post('/t/idem').set('Idempotency-Key', 'abc_DEF-1234').expect(201);
      expect(res.body).toEqual({ data: { key: 'abc_DEF-1234' } });
    });

    it('rejects a missing key', async () => {
      const res = await http().post('/t/idem').expect(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it.each([
      ['too short', 'abc1234'],
      ['too long', 'a'.repeat(129)],
      ['bad characters', 'abc def!1234'],
    ])('rejects a key that is %s', async (_label, key) => {
      const res = await http().post('/t/idem').set('Idempotency-Key', key).expect(400);
      expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });

  describe('@CurrentUser()', () => {
    it('returns only id and role from request.user', async () => {
      const res = await http().get('/t/me').expect(200);
      expect(res.body).toEqual({ data: { id: 'user-1', role: 'admin' } });
    });

    it('fails loudly (500) when the route has no auth guard', async () => {
      const res = await http().get('/t/me-unguarded').expect(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
