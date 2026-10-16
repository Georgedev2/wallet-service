import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { setupSwagger } from '../src/swagger';

describe('Swagger docs (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
    // Same order as main.ts: docs routes must be registered before init adds the 404 handler.
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the Swagger UI at /docs', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('documents every endpoint, with bearer auth and the Idempotency-Key header', async () => {
    const { body: doc } = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const operations = Object.entries(doc.paths as Record<string, object>).flatMap(
      ([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual(
      [
        'GET /',
        'POST /auth/login',
        'POST /users',
        'GET /users/me',
        'PATCH /admin/users/{id}/block',
        'PATCH /admin/users/{id}/unblock',
        'GET /admin/users/{id}/status-history',
        'GET /wallets/{id}',
        'GET /wallets/{id}/transactions',
        'POST /admin/wallets/{id}/fund',
        'POST /transfers',
        'POST /admin/blacklist',
        'DELETE /admin/blacklist/{id}',
      ].sort(),
    );

    const transfer = doc.paths['/transfers'].post;
    expect(transfer.security).toEqual([{ bearer: [] }]);
    expect(transfer.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
    expect(doc.paths['/admin/wallets/{id}/fund'].post.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
    expect(doc.paths['/auth/login'].post.security).toBeUndefined();
  });
});
