import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { HistoryQuery, WalletIdParams } from './wallets.dto';
import { WalletsService } from './wallets.service';

@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get(':id')
  getWallet(@CurrentUser() user: AuthUser, @Param() params: WalletIdParams) {
    return this.wallets.getWallet(user, params.id);
  }

  @Get(':id/transactions')
  getHistory(
    @CurrentUser() user: AuthUser,
    @Param() params: WalletIdParams,
    @Query() query: HistoryQuery,
  ) {
    return this.wallets.getHistory(user, params.id, query.limit, query.cursor);
  }
}
