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
  const config = app.get(ConfigService<Env, true>);
  configureApp(app, { corsOrigins: config.get('CORS_ORIGINS') });
  setupSwagger(app);
  // On SIGTERM from Render: stop accepting connections, finish open requests, then close the pg pool.
  app.enableShutdownHooks();
  await app.listen(config.get('PORT'));
}
void bootstrap();
