import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateTransferDto } from './transfers.dto';
import { TransfersService } from './transfers.service';

@Controller('transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** 201 for a new transfer; 200 with replayed: true when the Idempotency-Key was seen before. */
  @Post()
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
