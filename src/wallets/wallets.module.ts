import { Module } from '@nestjs/common';
import { AdminWalletsController } from './admin-wallets.controller';
import { WalletsController } from './wallets.controller';
import { WalletsRepository } from './wallets.repository';
import { WalletsService } from './wallets.service';

@Module({
  controllers: [WalletsController, AdminWalletsController],
  providers: [WalletsRepository, WalletsService],
  exports: [WalletsRepository],
})
export class WalletsModule {}
