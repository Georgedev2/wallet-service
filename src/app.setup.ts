import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

/** HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication): INestApplication {
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  return app;
}
