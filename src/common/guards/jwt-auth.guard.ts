import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../decorators/current-user.decorator';
import { DomainError } from '../errors/domain.error';

/** Requires a valid Bearer token; puts { id, role } on request.user. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = AuthUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) {
      throw new DomainError('UNAUTHORIZED', 'Missing or invalid access token', 401);
    }
    return user;
  }
}
