import { Module } from '@nestjs/common';
import { WalletsRepository } from './wallets.repository';

@Module({
  providers: [WalletsRepository],
  exports: [WalletsRepository],
})
export class WalletsModule {}
