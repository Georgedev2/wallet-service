import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SignupDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @ApiOperation({
    summary: 'Sign up; creates the user and an NGN wallet',
    description:
      'Errors: 403 USER_BLACKLISTED, 409 USER_EXISTS, ' +
      '400 VALIDATION_ERROR | INVALID_PHONE | INVALID_BVN, 429 after 10 signups/min per IP.',
  })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  signup(@Body() dto: SignupDto) {
    return this.users.signup(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The current user and their wallets' })
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.users.getMe(user.id);
  }
}
