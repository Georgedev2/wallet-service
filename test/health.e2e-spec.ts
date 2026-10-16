import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PG_POOL } from '../src/database/database.constants';
import { createApp } from './helpers';

describe('GET /health (e2e)', () => {
  it('returns 200 with status and db ok, without a token', async () => {
    const app = await createApp();
    try {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({ data: { status: 'ok', db: 'ok' } });
    } finally {
      await app.close();
    }
  });

  describe('when the database is unreachable', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      // A real pg Pool pointed at a port nothing listens on.
      const unreachable = new Pool({
        connectionString: 'postgres://postgres:postgres@127.0.0.1:1/wallet_test',
        connectionTimeoutMillis: 500,
      });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PG_POOL)
        .useValue(unreachable)
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
      configureApp(app, {
        corsOrigins: app.get(ConfigService).get('CORS_ORIGINS'),
      });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 503 DB_UNAVAILABLE with the error shape', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body).toEqual({
        error: { code: 'DB_UNAVAILABLE', message: 'The database is unreachable' },
      });
    });
  });
});
