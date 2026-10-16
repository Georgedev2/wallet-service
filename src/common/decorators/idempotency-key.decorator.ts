import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { DomainError } from '../errors/domain.error';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function idempotencyKeyFromContext(ctx: ExecutionContext): string {
  const key = ctx.switchToHttp().getRequest<Request>().header('Idempotency-Key');
  if (key === undefined || key === '') {
    throw new DomainError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required', 400);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new DomainError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8-128 characters of A-Z, a-z, 0-9, _ or -',
      400,
    );
  }
  return key;
}

export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  idempotencyKeyFromContext(ctx),
);
