import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Runs onModuleDestroy hooks (e.g. closing the pg pool) on SIGTERM from Render.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3600);
}
void bootstrap();
