import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { HistoryQuery, WalletIdParams } from './wallets.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'A wallet (owner or admin)',
    description: 'Anyone else gets 404 WALLET_NOT_FOUND.',
  })
  getWallet(@CurrentUser() user: AuthUser, @Param() params: WalletIdParams) {
    return this.wallets.getWallet(user, params.id);
  }

  @Get(':id/transactions')
  @ApiOperation({
    summary: 'Wallet history, newest first',
    description: 'Pass the response nextCursor back as cursor for the next page.',
  })
  getHistory(
    @CurrentUser() user: AuthUser,
    @Param() params: WalletIdParams,
    @Query() query: HistoryQuery,
  ) {
    return this.wallets.getHistory(user, params.id, query.limit, query.cursor);
  }
}
