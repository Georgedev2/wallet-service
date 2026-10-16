import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { Env } from './config/configuration';
import { setupSwagger } from './swagger';

async function bootstrap() {
  // Buffer startup logs until the pino logger is attached.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Render terminates TLS at one proxy hop; without this, req.ip is the proxy's
  // address and the login throttle would be shared by every client.
  app.set('trust proxy', 1);
  configureApp(app);
  setupSwagger(app);
  // Runs onModuleDestroy hooks (e.g. closing the pg pool) on SIGTERM from Render.
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService<Env, true>).get('PORT'));
}
void bootstrap();
