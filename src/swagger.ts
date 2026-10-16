import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'docs';

/** Interactive API docs at /docs (OpenAPI JSON at /docs-json). */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Wallet Service')
    .setDescription(
      [
        'Responses are wrapped: success is `{ "data": ... }`, errors are',
        '`{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "..." } }`.',
        '',
        'Money is integer kobo sent as a string of digits: `"150000"` is ₦1,500.00.',
        '',
        '**To test:** call `POST /auth/login`, copy `data.accessToken`, click **Authorize** and paste it.',
        'Money endpoints need a fresh `Idempotency-Key` per new movement; resending the same key',
        'and body replays the original result.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup(SWAGGER_PATH, app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: true },
  });
}
