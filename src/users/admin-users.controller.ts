import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StatusChangeDto, UserIdParams } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('admin: users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Patch(':id/block')
  @ApiOperation({
    summary: 'Block a user (can log in and view, cannot send or receive)',
    description: 'Errors: 409 ALREADY_BLOCKED, 422 CANNOT_BLOCK_SELF, 404 USER_NOT_FOUND.',
  })
  block(
    @CurrentUser() admin: AuthUser,
    @Param() params: UserIdParams,
    @Body() dto: StatusChangeDto,
  ) {
    return this.users.block(admin.id, params.id, dto.reason);
  }

  @Patch(':id/unblock')
  @ApiOperation({
    summary: 'Unblock a user',
    description: 'Errors: 409 NOT_BLOCKED, 404 USER_NOT_FOUND.',
  })
  unblock(
    @CurrentUser() admin: AuthUser,
    @Param() params: UserIdParams,
    @Body() dto: StatusChangeDto,
  ) {
    return this.users.unblock(admin.id, params.id, dto.reason);
  }

  @Get(':id/status-history')
  @ApiOperation({ summary: 'Block/unblock events, newest first' })
  statusHistory(@Param() params: UserIdParams) {
    return this.users.getStatusHistory(params.id);
  }
}
