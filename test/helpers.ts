import { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/** The full app with the production HTTP pipeline, plus any test-only controllers. */
export async function createApp(controllers: Type[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers,
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, { corsOrigins: app.get(ConfigService).get('CORS_ORIGINS') });
  await app.init();
  return app;
}
