import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, LoginResult } from './auth.service';
import { LoginDto } from './login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @ApiOperation({
    summary: 'Log in and get a JWT',
    description:
      'Errors: 401 INVALID_CREDENTIALS, 400 VALIDATION_ERROR, 429 after 5 attempts/min per IP.',
  })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password);
  }
}
