import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { Env } from './config/configuration';

async function bootstrap() {
  // Buffer startup logs until the pino logger is attached.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  // Runs onModuleDestroy hooks (e.g. closing the pg pool) on SIGTERM from Render.
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService<Env, true>).get('PORT'));
}
void bootstrap();
