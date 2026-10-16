import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

export const BODY_LIMIT = '10kb';

export interface AppSetupOptions {
  /** Browser origins allowed by CORS (CORS_ORIGINS). Empty: no cross-origin access. */
  corsOrigins?: string[];
}

/** HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the real setup. */
export function configureApp(
  app: NestExpressApplication,
  { corsOrigins = [] }: AppSetupOptions = {},
): NestExpressApplication {
  app.use(helmet());
  // Every payload here is a few hundred bytes; a small cap limits memory per request.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.enableCors({
    origin: corsOrigins,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  return app;
}
