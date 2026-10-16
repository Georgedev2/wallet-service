import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiIdempotencyKey, IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FundWalletDto, WalletIdParams } from './wallets.dto';
import { WalletsService } from './wallets.service';

@ApiTags('admin: wallets')
@ApiBearerAuth()
@Controller('admin/wallets')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminWalletsController {
  constructor(private readonly wallets: WalletsService) {}

  /** 201 for a new funding; 200 with replayed: true when the Idempotency-Key was seen before. */
  @Post(':id/fund')
  @ApiIdempotencyKey()
  @ApiOperation({
    summary: 'Fund a wallet',
    description:
      '201 new funding; 200 replay. Errors: 409 IDEMPOTENCY_KEY_REUSED, 404 WALLET_NOT_FOUND, ' +
      '403 USER_BLOCKED, 422 WALLET_FROZEN, 400 INVALID_AMOUNT | MISSING_IDEMPOTENCY_KEY.',
  })
  async fund(
    @CurrentUser() admin: AuthUser,
    @Param() params: WalletIdParams,
    @IdempotencyKey() key: string,
    @Body() dto: FundWalletDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.wallets.fund(
      admin.id,
      params.id,
      key,
      dto.amount,
      dto.narration ?? null,
    );
    res.status(replayed ? 200 : 201);
    return { ...result, replayed };
  }
}
