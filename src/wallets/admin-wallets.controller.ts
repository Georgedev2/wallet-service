import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FundWalletDto, WalletIdParams } from './wallets.dto';
import { WalletsService } from './wallets.service';

@Controller('admin/wallets')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminWalletsController {
  constructor(private readonly wallets: WalletsService) {}

  /** 201 for a new funding; 200 with replayed: true when the Idempotency-Key was seen before. */
  @Post(':id/fund')
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
