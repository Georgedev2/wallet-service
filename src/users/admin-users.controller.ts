import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StatusChangeDto, UserIdParams } from './users.dto';
import { UsersService } from './users.service';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Patch(':id/block')
  block(
    @CurrentUser() admin: AuthUser,
    @Param() params: UserIdParams,
    @Body() dto: StatusChangeDto,
  ) {
    return this.users.block(admin.id, params.id, dto.reason);
  }

  @Patch(':id/unblock')
  unblock(
    @CurrentUser() admin: AuthUser,
    @Param() params: UserIdParams,
    @Body() dto: StatusChangeDto,
  ) {
    return this.users.unblock(admin.id, params.id, dto.reason);
  }

  @Get(':id/status-history')
  statusHistory(@Param() params: UserIdParams) {
    return this.users.getStatusHistory(params.id);
  }
}
