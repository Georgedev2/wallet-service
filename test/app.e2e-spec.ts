import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/ (GET)', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.body).toEqual({ data: 'Hello World!' });
  });

  it('generates a request id', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a safe incoming request id and replaces an unsafe one', async () => {
    const safe = await request(app.getHttpServer()).get('/').set('X-Request-Id', 'abc-123');
    expect(safe.headers['x-request-id']).toBe('abc-123');

    const unsafe = await request(app.getHttpServer()).get('/').set('X-Request-Id', 'bad id!');
    expect(unsafe.headers['x-request-id']).not.toBe('bad id!');
  });
});
