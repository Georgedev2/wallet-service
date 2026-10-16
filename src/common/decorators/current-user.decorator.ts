import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

export type Role = 'user' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
}

/** Only for routes behind the JWT guard, which puts { id, role } on request.user. */
export function currentUserFromContext(ctx: ExecutionContext): AuthUser {
  const user = ctx.switchToHttp().getRequest<Request>().user as Partial<AuthUser> | undefined;
  if (!user?.id || !user.role) {
    // A programming error (route missing its guard), not a client error.
    throw new Error('@CurrentUser() used on a route without authentication');
  }
  return { id: user.id, role: user.role };
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  currentUserFromContext(ctx),
);
