import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { currentUserFromContext } from '../decorators/current-user.decorator';
import { ForbiddenError } from '../errors/domain.error';

/** Use after JwtAuthGuard: @UseGuards(JwtAuthGuard, AdminGuard). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (currentUserFromContext(ctx).role !== 'admin') {
      throw new ForbiddenError('FORBIDDEN', 'Admin access required');
    }
    return true;
  }
}
