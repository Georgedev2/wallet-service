import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiIdempotencyKey, IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateTransferDto } from './transfers.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller('transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** 201 for a new transfer; 200 with replayed: true when the Idempotency-Key was seen before. */
  @Post()
  @ApiIdempotencyKey()
  @ApiOperation({
    summary: 'Transfer from your wallet to another',
    description:
      '201 new transfer; 200 replay. Errors: 409 IDEMPOTENCY_KEY_REUSED, 404 WALLET_NOT_FOUND, ' +
      '403 FORBIDDEN | USER_BLOCKED, 422 INSUFFICIENT_FUNDS | SAME_WALLET | WALLET_FROZEN | ' +
      'CURRENCY_MISMATCH, 503 TRY_AGAIN, 400 INVALID_AMOUNT | MISSING_IDEMPOTENCY_KEY.',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.transfers.transfer(user.id, key, {
      sourceWalletId: dto.sourceWalletId,
      destinationWalletId: dto.destinationWalletId,
      amount: dto.amount,
      narration: dto.narration ?? null,
    });
    res.status(replayed ? 200 : 201);
    return { ...result, replayed };
  }
}
